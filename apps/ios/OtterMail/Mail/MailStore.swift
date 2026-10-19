import Foundation
import Observation
import SwiftUI

/**
 * Everything the app shows and does with mail. Local-first, as on the Mac:
 * screens render from here and never wait on the network. Changes show at
 * once and are handed to `sync`, which writes them to Gmail; in the demo
 * there's no sync and the pretend mail just changes.
 */
@Observable
final class MailStore {
    private(set) var mailboxes: [Mailbox]
    private(set) var threads: [MailThread] {
        didSet { folderThreads.removeAll(); unreadCounts.removeAll() }
    }
    @ObservationIgnored private var folderThreads: [Place: [MailThread]] = [:]
    @ObservationIgnored private var unreadCounts: [Place: Int] = [:]
    @ObservationIgnored private var cachedShown: [String] = []
    let preferences: Preferences
    private(set) var recoveredDrafts: [RecoveredDraft] = []
    @ObservationIgnored private var recoveryDirectory: URL?
    private(set) var undoAction: PendingAction?
    @ObservationIgnored private var undoTask: Task<Void, Never>?

    struct PendingAction {
        let id = UUID()
        let trash: Bool
        let threads: [MailThread]
        var title: String { "\(threads.count == 1 ? "Conversation" : "\(threads.count) conversations") \(trash ? "trashed" : "archived")" }
    }
    /** Gmail, for signed-in mailboxes; nil in the demo. */
    @ObservationIgnored var sync: MailSync?

    init(preferences: Preferences, mailboxes: [Mailbox] = [], threads: [MailThread] = []) {
        self.preferences = preferences
        self.mailboxes = mailboxes
        self.threads = threads
    }

    static func demo(preferences: Preferences) -> MailStore {
        let demo = DemoMail.load()
        let store = MailStore(preferences: preferences, mailboxes: demo.mailboxes, threads: demo.threads)
        store.configureRecovery(namespace: "demo")
        return store
    }

    var isDemo: Bool { sync == nil }

    // ── Mailboxes ────────────────────────────────────────────────────────────

    /** Every mailbox in the user's order, turned-off ones included. */
    var arrangedMailboxes: [Mailbox] {
        let order = preferences.arrangement.order
        let rank = { (m: Mailbox) in order.firstIndex(of: m.email) ?? order.count }
        return mailboxes.enumerated()
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .map(\.element)
    }

    /** The mailboxes the app shows: turned on, in order. */
    var shownMailboxes: [Mailbox] {
        arrangedMailboxes.filter { !preferences.arrangement.off.contains($0.email) }
    }

    /** "All mailboxes" is offered (it needs two or more). */
    var offersCombined: Bool { preferences.arrangement.combined && shownMailboxes.count > 1 }

    func mailbox(_ email: String) -> Mailbox? { mailboxes.first { $0.email == email } }

    func upsert(mailbox: Mailbox) {
        if let i = mailboxes.firstIndex(where: { $0.email == mailbox.email }) {
            if mailboxes[i] != mailbox { mailboxes[i] = mailbox }
        } else {
            mailboxes.append(mailbox)
        }
    }

    /** Removes the mailbox and its mail from this device; nothing is deleted from Gmail. */
    func remove(mailbox email: String) {
        commitPendingAction()
        for recovery in recoveredDrafts where recovery.draft.from == email { removeRecovery(recovery.draft, deletingFiles: true) }
        mailboxes.removeAll { $0.email == email }
        threads.removeAll { $0.mailbox == email }
        preferences.arrangement.order.removeAll { $0 == email }
        preferences.arrangement.off.removeAll { $0 == email }
    }

    func setSignedOut(_ signedOut: Bool, _ email: String) {
        if !signedOut { setLostSignIn(false, email) }
        guard var mailbox = mailbox(email), mailbox.signedOut != signedOut else { return }
        mailbox.signedOut = signedOut
        upsert(mailbox: mailbox)
    }

    // ── Sync health ──────────────────────────────────────────────────────────

    /** How a mailbox's last sync went, for the drawer's status line. */
    struct SyncHealth: Equatable {
        var syncedAt: Date?
        /** Why the last sync failed ("Can't connect"); nil when it worked. */
        var failure: String?
    }
    private(set) var health: [String: SyncHealth] = [:]

    func recordSync(_ email: String, failure: String?) {
        var entry = health[email] ?? SyncHealth()
        if failure == nil { entry.syncedAt = .now }
        entry.failure = failure
        health[email] = entry
    }

    /**
     * Mailboxes this iPhone was signed in to until the provider ended it
     * (revoked, expired, a refused password): raised on the mail list, not
     * just in the drawer. Kept across launches until signed in again.
     */
    private(set) var lostSignIn = Set(UserDefaults.standard.stringArray(forKey: "mail.lostSignIn") ?? [])

    func setLostSignIn(_ lost: Bool, _ email: String) {
        guard lostSignIn.contains(email) != lost else { return }
        if lost { lostSignIn.insert(email) } else { lostSignIn.remove(email) }
        UserDefaults.standard.set(lostSignIn.sorted(), forKey: "mail.lostSignIn")
    }

    func setOn(_ on: Bool, _ mailbox: Mailbox) {
        var off = Set(preferences.arrangement.off)
        if on { off.remove(mailbox.email) } else { off.insert(mailbox.email) }
        preferences.arrangement.off = arrangedMailboxes.map(\.email).filter(off.contains)
    }

    func move(from source: IndexSet, to destination: Int) {
        var order = arrangedMailboxes.map(\.email)
        order.move(fromOffsets: source, toOffset: destination)
        preferences.arrangement.order = order
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    /** A folder's threads in `scope` (a mailbox's address, or nil for all shown), newest first. */
    func threads(in folder: Folder, scope: String?) -> [MailThread] {
        prepareFolderCache()
        let key = Place(scope: scope, folder: folder)
        if let cached = folderThreads[key] { return cached }
        let result = inScope(scope).filter { matches($0, folder) }.sorted { $0.latest.date > $1.latest.date }
        folderThreads[key] = result
        return result
    }

    func unreadCount(in folder: Folder, scope: String?) -> Int {
        prepareFolderCache()
        let key = Place(scope: scope, folder: folder)
        if let cached = unreadCounts[key] { return cached }
        let count = inScope(scope).reduce(0) { $0 + ($1.unread && matches($1, folder) ? 1 : 0) }
        unreadCounts[key] = count
        return count
    }

    private func prepareFolderCache() {
        // Cache hits must still subscribe the view to mail and visibility changes.
        _ = threads
        let shown = shownMailboxes.map(\.email)
        if cachedShown != shown {
            cachedShown = shown
            folderThreads.removeAll()
            unreadCounts.removeAll()
        }
    }

    /** A folder's count in the sidebar, as on the desktop: its unread mail, but every draft in Drafts and none on All Mail. */
    func badge(in folder: Folder, scope: String?) -> Int {
        switch folder {
        case .allMail: return 0
        case .drafts:
            let saved = inScope(scope).filter { matches($0, .drafts) }.flatMap(\.messages).filter(\.draft)
            let shown = Set(shownMailboxes.map(\.email))
            let local = recoveredDrafts.filter { entry in
                (scope.map { entry.draft.from == $0 } ?? shown.contains(entry.draft.from))
                    && !saved.contains(where: { $0.id == entry.draft.messageID })
            }
            return saved.count + local.count
        default: return unreadCount(in: folder, scope: scope)
        }
    }

    func thread(_ id: String) -> MailThread? { threads.first { $0.id == id } }

    func allThreads(of email: String) -> [MailThread] { threads.filter { $0.mailbox == email } }

    private func inScope(_ scope: String?) -> [MailThread] {
        let shown = Set(shownMailboxes.map(\.email))
        return threads.filter { thread in scope.map { thread.mailbox == $0 } ?? shown.contains(thread.mailbox) }
    }

    private func matches(_ thread: MailThread, _ folder: Folder) -> Bool {
        let away = thread.labels.contains("SPAM") || thread.labels.contains("TRASH")
        switch folder {
        case .inbox: return thread.labels.contains("INBOX") && !away
        case .starred: return thread.starred && !away
        case .sent: return thread.sent.contains { $0.from.email.lowercased() == thread.mailbox.lowercased() } && !away
        case .drafts: return thread.messages.contains(where: \.draft) && !away
        case .important: return thread.labels.contains("IMPORTANT") && !away
        case .allMail: return !away && !thread.isDraft
        case .junk: return thread.labels.contains("SPAM")
        case .trash: return thread.labels.contains("TRASH")
        case .label(let id, _): return thread.labels.contains(id) && !away
        }
    }

    /**
     * Gmail-style search over what's here: `from:`, `to:`, `subject:`,
     * `label:`, `is:unread`, `is:starred`, `has:attachment`, and words
     * anywhere. Junk and Trash are left out, as in Gmail.
     */
    func search(_ query: String, scope: String?) -> [MailThread] {
        let terms = query.lowercased().split(separator: " ").map(String.init)
        guard !terms.isEmpty else { return [] }
        let labels = Dictionary(mailboxes.flatMap(\.labels).map { ($0.id, $0.name.lowercased()) }) { a, _ in a }
        return inScope(scope)
            .filter { !$0.labels.contains("SPAM") && !$0.labels.contains("TRASH") }
            .filter { thread in terms.allSatisfy { Self.term($0, matches: thread, labels: labels) } }
            .sorted { $0.latest.date > $1.latest.date }
    }

    private static func term(_ term: String, matches thread: MailThread, labels: [String: String]) -> Bool {
        let people = { (list: [Person]) in list.map { "\($0.name) \($0.email)".lowercased() } }
        let (op, value) = term.contains(":")
            ? (String(term.prefix { $0 != ":" }), String(term.drop { $0 != ":" }.dropFirst()))
            : ("", term)
        switch op {
        case "from": return people(thread.messages.map(\.from)).contains { $0.contains(value) }
        case "to": return people(thread.messages.flatMap { $0.to + $0.cc }).contains { $0.contains(value) }
        case "subject": return thread.subject.lowercased().contains(value)
        case "label": return thread.labels.contains { $0.lowercased() == value || labels[$0] == value }
        case "is" where value == "unread": return thread.unread
        case "is" where value == "starred": return thread.starred
        case "has" where value == "attachment": return thread.hasAttachments
        default:
            let haystack = ([thread.subject] + thread.messages.flatMap { [$0.from.name, $0.from.email, $0.text] })
                .joined(separator: " ").lowercased()
            return haystack.contains(term)
        }
    }

    // ── What sync brings ─────────────────────────────────────────────────────

    func upsert(threads fresh: [MailThread]) {
        guard !fresh.isEmpty else { return }
        var updated = threads
        var changed = false
        var index = Dictionary(uniqueKeysWithValues: threads.enumerated().map { ($1.id, $0) })
        for var thread in fresh {
            if let pending = undoAction, pending.threads.contains(where: { $0.id == thread.id }) {
                if pending.trash { thread.labels.subtract(["INBOX", "SPAM"]); thread.labels.insert("TRASH") }
                else { thread.labels.remove("INBOX") }
            }
            if let i = index[thread.id] {
                if updated[i] != thread { updated[i] = thread; changed = true }
            } else {
                index[thread.id] = updated.count
                updated.append(thread)
                changed = true
            }
        }
        if changed { threads = updated }
    }

    func remove(threadIDs: Set<String>) {
        guard !threadIDs.isEmpty else { return }
        threads.removeAll { threadIDs.contains($0.id) }
    }

    /** Drops a message shown before Gmail had it, and its thread if nothing else is left in it. */
    func remove(messageID: String) {
        for i in threads.indices { threads[i].messages.removeAll { $0.id == messageID } }
        threads.removeAll { $0.messages.isEmpty }
    }

    // ── Changing ─────────────────────────────────────────────────────────────

    /** A change to a thread, as Gmail takes it. */
    enum Change {
        case modify(add: [String], remove: [String])
        /** Gmail stars a message, not a thread: the latest. */
        case star(message: String)
        case trash, untrash, delete
    }

    private func edit(_ id: String, _ changes: [Change], _ change: (inout MailThread) -> Void) {
        commitPendingAction()
        guard let i = threads.firstIndex(where: { $0.id == id }) else { return }
        change(&threads[i])
        let thread = threads[i]
        for c in changes { sync?.apply(c, to: thread) }
    }

    func setRead(_ read: Bool, _ id: String) {
        let change = Change.modify(add: read ? [] : ["UNREAD"], remove: read ? ["UNREAD"] : [])
        edit(id, [change]) { t in for i in t.messages.indices { t.messages[i].unread = !read } }
    }

    func toggleStar(_ id: String) {
        guard let thread = thread(id) else { return }
        let starred = !thread.starred
        let latest = thread.sent.last ?? thread.latest
        edit(id, [starred ? .star(message: latest.id) : .modify(add: [], remove: ["STARRED"])]) { t in
            for i in t.messages.indices { t.messages[i].starred = starred && t.messages[i].id == latest.id }
        }
    }

    func archive(_ id: String) { archive([id]) }
    func trash(_ id: String) { trash([id]) }
    func archive(_ ids: Set<String>) { stage(ids, trash: false) }
    func trash(_ ids: Set<String>) { stage(ids, trash: true) }

    private func stage(_ ids: Set<String>, trash: Bool) {
        commitPendingAction()
        let originals = threads.filter { ids.contains($0.id) && (trash ? !$0.labels.contains("TRASH") : $0.labels.contains("INBOX")) }
        guard !originals.isEmpty else { return }
        undoAction = PendingAction(trash: trash, threads: originals)
        for i in threads.indices where originals.contains(where: { $0.id == threads[i].id }) {
            if trash { threads[i].labels.subtract(["INBOX", "SPAM"]); threads[i].labels.insert("TRASH") }
            else { threads[i].labels.remove("INBOX") }
        }
        undoTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            self?.commitPendingAction()
        }
    }

    func undo() {
        guard let action = undoAction else { return }
        undoTask?.cancel()
        undoAction = nil
        let affected: Set<String> = action.trash ? ["INBOX", "SPAM", "TRASH"] : ["INBOX"]
        for original in action.threads {
            guard let i = threads.firstIndex(where: { $0.id == original.id }) else { continue }
            threads[i].labels.subtract(affected)
            threads[i].labels.formUnion(original.labels.intersection(affected))
        }
    }

    func commitPendingAction() {
        undoTask?.cancel()
        guard let action = undoAction else { return }
        undoAction = nil
        for original in action.threads {
            sync?.apply(action.trash ? .trash : .modify(add: [], remove: ["INBOX"]), to: thread(original.id) ?? original)
        }
    }

    func markSpam(_ id: String) {
        edit(id, [.modify(add: ["SPAM"], remove: ["INBOX"])]) { t in
            t.labels.subtract(["INBOX", "TRASH"])
            t.labels.insert("SPAM")
        }
    }

    /** Back to the inbox, out of Junk or Trash. */
    func moveToInbox(_ id: String) {
        guard let thread = thread(id) else { return }
        let changes: [Change] = thread.labels.contains("TRASH")
            ? [.untrash, .modify(add: ["INBOX"], remove: [])]
            : [.modify(add: ["INBOX"], remove: ["SPAM"])]
        edit(id, changes) { t in
            t.labels.subtract(["SPAM", "TRASH"])
            t.labels.insert("INBOX")
        }
    }

    func deleteForever(_ id: String) {
        commitPendingAction()
        guard let thread = thread(id) else { return }
        threads.removeAll { $0.id == id }
        sync?.apply(.delete, to: thread)
    }

    func toggleLabel(_ label: String, _ id: String) {
        guard let thread = thread(id) else { return }
        let on = !thread.labels.contains(label)
        edit(id, [.modify(add: on ? [label] : [], remove: on ? [] : [label])]) { t in
            if on { t.labels.insert(label) } else { t.labels.remove(label) }
        }
    }

    /** Suggestions from this mailbox's cached correspondence, most recently seen first. */
    func contacts(matching query: String, from email: String, excluding: Set<String>) -> [Person] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        var seen = excluding
        seen.insert(email.lowercased())
        var matches: [Person] = []
        for thread in allThreads(of: email).sorted(by: { $0.latest.date > $1.latest.date }) {
            for message in thread.messages.reversed() {
                for person in [message.from] + message.to + message.cc {
                    let key = person.email.lowercased()
                    guard !seen.contains(key), Draft.validRecipient(person.email),
                          person.name.localizedStandardContains(query) || person.email.localizedStandardContains(query) else { continue }
                    seen.insert(key)
                    matches.append(person)
                    if matches.count == 6 { return matches }
                }
            }
        }
        return matches
    }

    func configureRecovery(namespace: String) {
        recoveryDirectory = URL.applicationSupportDirectory.appending(path: "draft-recovery").appending(path: namespace)
        guard let directory = recoveryDirectory else { return }
        recoveredDrafts = ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .compactMap { try? JSONDecoder().decode(RecoveredDraft.self, from: Data(contentsOf: $0)) }
            .sorted { $0.updated > $1.updated }
    }

    func recover(_ draft: Draft) -> Draft {
        recoveredDrafts.first { $0.draft.id == draft.id || (draft.messageID != nil && $0.draft.messageID == draft.messageID && $0.draft.from == draft.from) }?.draft ?? draft
    }

    func saveRecovery(_ draft: Draft) throws {
        guard let directory = recoveryDirectory else { throw Draft.Failure.recoveryUnavailable }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let entry = RecoveredDraft(draft: draft)
        try JSONEncoder().encode(entry).write(to: directory.appending(path: "\(draft.id).json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        recoveredDrafts.removeAll { $0.id == draft.id }
        recoveredDrafts.insert(entry, at: 0)
    }

    func removeRecovery(_ draft: Draft, deletingFiles: Bool = false) {
        if deletingFiles {
            for file in draft.files {
                if let url = file.url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
            }
        }
        if let directory = recoveryDirectory { try? FileManager.default.removeItem(at: directory.appending(path: "\(draft.id).json")) }
        recoveredDrafts.removeAll { $0.id == draft.id }
    }

    func clearRecovery() {
        for entry in recoveredDrafts { removeRecovery(entry.draft, deletingFiles: true) }
    }

    func attachmentURL(_ attachment: Attachment, of message: Message, in email: String) async throws -> URL {
        if let id = attachment.id, id.hasPrefix("local:") {
            let file = String(id.dropFirst(6))
            guard UUID(uuidString: file) != nil else { throw DraftFile.Failure.unavailable }
            let url = DraftFile.directory.appending(path: file).appending(path: URL(fileURLWithPath: attachment.filename).lastPathComponent)
            guard FileManager.default.fileExists(atPath: url.path) else { throw DraftFile.Failure.unavailable }
            return url
        }
        guard let sync else { throw DraftFile.Failure.unavailable }
        return try await sync.attachment(attachment, of: message, in: email)
    }

    func fileData(_ file: DraftFile, from email: String) async throws -> Data {
        if let url = file.url { return try Data(contentsOf: url) }
        let source = file.sourceMailbox ?? email
        guard let original = file.original, let message = allThreads(of: source).flatMap(\.messages).first(where: { $0.id == file.messageID }) else { throw DraftFile.Failure.unavailable }
        return try Data(contentsOf: await attachmentURL(original, of: message, in: source))
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /** Sends `draft`: into its thread when it's a reply, or as a new one. */
    func send(_ draft: Draft) async throws {
        guard draft.canSend else { throw Draft.Failure.invalidRecipients }
        try await write(draft, asDraft: false)
        removeRecovery(draft, deletingFiles: !isDemo)
    }

    /** Keeps `draft` in Drafts (only when there's something in it). */
    func save(_ draft: Draft) async throws {
        guard !draft.isEmpty else { return await discard(draft) }
        try await write(draft, asDraft: true)
        removeRecovery(draft, deletingFiles: !isDemo)
    }

    func discard(_ draft: Draft) async {
        removeRecovery(draft, deletingFiles: true)
        guard let messageID = draft.messageID else { return }
        remove(messageID: messageID)
        await sync?.discard(draft)
    }

    /** Shows the message at once, then hands it to Gmail (which answers with its own copy). */
    private func write(_ draft: Draft, asDraft: Bool) async throws {
        guard let mailbox = mailbox(draft.from), !mailbox.signedOut else { throw Draft.Failure.mailboxUnavailable }
        guard draft.files.reduce(0, { $0 + $1.size }) <= DraftFile.limit else { throw DraftFile.Failure.tooLarge }
        let localID = UUID().uuidString
        let message = Message(
            id: localID,
            from: mailbox.me,
            to: Draft.people(draft.to),
            cc: Draft.people(draft.cc),
            date: .now,
            text: draft.body,
            html: nil,
            attachments: draft.files.map(\.attachment),
            unread: false,
            starred: false,
            draft: asDraft,
            headers: draft.bcc.isEmpty ? [:] : ["Bcc": draft.bcc]
        )
        // A draft picked back up is replaced by what it becomes.
        let threadID = draft.threadID ?? draft.messageID.flatMap { id in threads.first { $0.messages.contains { $0.id == id } }?.id }
        if let threadID, let i = threads.firstIndex(where: { $0.id == threadID }) {
            threads[i].messages.append(message)
            if !asDraft { threads[i].labels.insert("SENT") }
        } else {
            threads.append(MailThread(
                id: UUID().uuidString,
                mailbox: mailbox.email,
                subject: draft.subject.isEmpty ? "(no subject)" : draft.subject,
                labels: asDraft ? [] : ["SENT"],
                messages: [message]
            ))
        }
        threads.removeAll { $0.messages.isEmpty }
        guard let sync else {
            if let previous = draft.messageID { remove(messageID: previous) }
            return
        }
        do {
            try await sync.write(draft, asDraft: asDraft)
        } catch {
            remove(messageID: localID)
            throw error
        }
        remove(messageID: localID)
    }
}
