import Foundation
import Observation
import UserNotifications

/**
 * Keeps signed-in mailboxes in step with their servers, local-first like
 * core's mail-sync.ts: the store renders from its copy (cached on disk, so
 * launch is instant), changes are made there first and then written through
 * the mailbox's provider (Gmail, IMAP or Outlook), and the provider catches
 * the copy up when a mailbox changed (a relay event, IDLE), on launch and when the
 * app comes back. Observable, so lists follow where their folders' pages got to.
 */
@MainActor
@Observable
final class MailSync {
    private let store: MailStore
    private let google: GoogleAuth
    private let microsoft: MicrosoftAuth
    private let relay: Relay?
    private var providers: [String: any MailProvider] = [:]
    private var states: [String: MailboxState] = [:]
    private var running: [String: Task<Void, Never>] = [:]
    private var watching: [String: Task<Void, Never>] = [:]
    private var saving: Task<Void, Never>?
    @ObservationIgnored private let cache: MailCache
    @ObservationIgnored private var cacheLoad: Task<Void, Never>?
    @ObservationIgnored private var forgotten: Set<String> = []
    private(set) var loadingCache = false
    /** Successfully registered Gmail mailboxes use APNs as the sole alert source. */
    var pushMailboxes: Set<String> = []
    @ObservationIgnored private var stopped = false
    /** Mailboxes with a provider call under way, and the calls waiting their turn. */
    private var busy: Set<String> = []
    private var waiting: [String: [CheckedContinuation<Void, Never>]] = [:]
    /** Folder pages being fetched ("email key"), so the same page isn't asked for twice at once. */
    private var paging: Set<String> = []

    init(store: MailStore, google: GoogleAuth, microsoft: MicrosoftAuth = MicrosoftAuth(), relay: Relay? = nil, cache: MailCache = .live) {
        self.store = store
        self.google = google
        self.microsoft = microsoft
        self.relay = relay
        self.cache = cache
    }

    /** The mailbox's provider: IMAP when it has IMAP settings, Outlook for an Outlook mailbox, else Gmail. */
    private func provider(_ email: String) -> any MailProvider {
        if let provider = providers[email] { return provider }
        let provider: any MailProvider = if let settings = store.mailbox(email)?.imap {
            ImapProvider(email: email, settings: settings)
        } else if store.mailbox(email)?.provider == .outlook {
            OutlookProvider(
                email: email,
                api: GraphAPI(email: email) { [microsoft] force in try await microsoft.accessToken(email, force: force) },
                watchTarget: relay.map { relay in { try await relay.outlookWatch(email) } }
            )
        } else {
            GmailProvider(api: GmailAPI(email: email) { [google] force in try await google.accessToken(email, force: force) })
        }
        providers[email] = provider
        return provider
    }

    /**
     * Runs `body` with the mailbox's provider and state, then shows what it
     * answers. For a provider whose calls rewrite what's here (`takesTurns`:
     * IMAP moves re-key messages), one at a time per mailbox, so each starts
     * from what the last left: a sync that IDLE starts while a move is under
     * way would otherwise bring the thread back as it was. Gmail's calls run
     * side by side, as bulk actions want.
     */
    @discardableResult
    private func run(
        _ email: String, _ body: (any MailProvider, inout MailboxState, [MailThread]) async throws -> MailDelta
    ) async throws -> MailDelta {
        await waitForCache()
        try Task.checkCancellation()
        guard !stopped, store.mailbox(email) != nil else { throw CancellationError() }
        let provider = provider(email)
        let turns = provider.takesTurns
        if turns, busy.contains(email) {
            await withCheckedContinuation { waiting[email, default: []].append($0) }
        } else if turns {
            busy.insert(email)
        }
        defer {
            if turns, let next = waiting[email]?.first {
                waiting[email]?.removeFirst()
                next.resume()
            } else if turns {
                busy.remove(email)
            }
        }
        var state = states[email] ?? MailboxState()
        let delta = try await body(provider, &state, store.allThreads(of: email))
        try Task.checkCancellation()
        guard !stopped, store.mailbox(email) != nil else { throw CancellationError() }
        states[email] = state
        store.remove(threadIDs: delta.removed.subtracting(delta.threads.map(\.id)))
        store.upsert(threads: delta.threads)
        scheduleSave()
        return delta
    }

    // ── The cache ────────────────────────────────────────────────────────────

    /** Restore before network sync, without holding up the first frame or gestures. */
    func loadCache(for emails: [String]) {
        guard cacheLoad == nil else { return }
        loadingCache = true
        let mailboxes = Dictionary(uniqueKeysWithValues: store.mailboxes.map { ($0.email, $0) })
        cacheLoad = Task {
            let snapshots = await cache.load(emails)
            defer { loadingCache = false }
            guard !Task.isCancelled else { return }
            for cached in snapshots where !forgotten.contains(cached.mailbox.email) && store.mailbox(cached.mailbox.email) != nil {
                states[cached.mailbox.email] = cached.state
                if store.mailbox(cached.mailbox.email) == mailboxes[cached.mailbox.email] {
                    store.upsert(mailbox: cached.mailbox)
                }
                store.upsert(threads: cached.threads)
            }
        }
    }

    func waitForCache() async { await cacheLoad?.value }

    /** Writes the copy soon (changes come in bursts). */
    private func scheduleSave() {
        guard !stopped else { return }
        saving?.cancel()
        saving = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            save()
        }
    }

    private func save() {
        let snapshots = store.mailboxes.filter { !$0.signedOut && !forgotten.contains($0.email) }.map { mailbox in
            MailCache.Snapshot(mailbox: mailbox, state: states[mailbox.email] ?? MailboxState(), threads: store.allThreads(of: mailbox.email))
        }
        cache.save(snapshots)
    }

    func forget(_ email: String) {
        forgotten.insert(email)
        states[email] = nil
        providers[email] = nil
        running[email]?.cancel()
        running[email] = nil
        watching.removeValue(forKey: email)?.cancel()
        cache.remove(email)
    }

    /** Signed out (or moved to other servers): the provider and its IDLE go; the copy stays. */
    func stop(_ email: String) {
        providers[email] = nil
        watching.removeValue(forKey: email)?.cancel()
    }

    func forgetAll() {
        stopped = true
        saving?.cancel()
        cacheLoad?.cancel()
        for email in Set(states.keys).union(providers.keys) { forget(email) }
        cache.removeAll()
    }

    // ── Syncing ──────────────────────────────────────────────────────────────

    /** Catches every signed-in, turned-on mailbox up. */
    func syncAll(notify: Bool = false) async {
        await withTaskGroup(of: Void.self) { group in
            for mailbox in store.shownMailboxes where !mailbox.signedOut {
                group.addTask { await self.sync(mailbox.email, notify: notify) }
            }
        }
    }

    /** Catches one mailbox up (one sync at a time per mailbox). */
    func sync(_ email: String, notify: Bool = false) async {
        await waitForCache()
        guard !stopped, !Task.isCancelled, store.mailbox(email) != nil else { return }
        forgotten.remove(email)
        if let running = running[email] { return await running.value }
        let task = Task { await catchUp(email, notify: notify) }
        running[email] = task
        await task.value
        running[email] = nil
    }

    private func catchUp(_ email: String, notify: Bool) async {
        do {
            let before = Dictionary(store.allThreads(of: email).map { ($0.id, $0) }) { a, _ in a }
            let delta = try await run(email) { provider, state, known in try await provider.sync(&state, known: known) }
            if store.mailbox(email)?.provider == .gmail, let historyID = states[email]?.historyID,
               let config = PushState.configuration(), config.mailboxes.contains(email.lowercased()) {
                try? await PushState.locked("notification:" + email) {
                    guard PushState.configuration()?.userId == config.userId else { return }
                    let cursor = PushState.cursor(email)
                    // APNs owns its cursor once registered: a WebSocket/background sync must not consume its pending additions.
                    if cursor?.userId != config.userId || (!pushMailboxes.contains(email.lowercased()) && GmailNotification.newer(historyID, than: cursor?.historyId ?? "0")) {
                        try PushState.save(.init(userId: config.userId, historyId: historyID), email: email)
                    }
                }
            }
            if notify { await announce(delta.threads, before: before) }
            let provider = provider(email)
            let labels = try await provider.labels()
            let signature = try await provider.signature()
            // Read after the awaits, so what changed meanwhile (a synced signature) isn't written over.
            if var mailbox = store.mailbox(email) {
                mailbox.labels = labels
                if let signature { mailbox.signature = signature }
                store.upsert(mailbox: mailbox)
            }
            scheduleSave()
        } catch where Self.signedOut(error) {
            // A password the server refuses is no use kept (as GoogleAuth drops a revoked sign-in).
            if store.mailbox(email)?.imap != nil { ImapProvider.setPassword(nil, for: email) }
            store.setSignedOut(true, email)
            stop(email)
        } catch {
            // Offline or the server refused: the copy stands, and the next sync tries again.
        }
    }

    /** The sign-in is gone (Google's, Microsoft's, or the IMAP password): only signing in again helps. */
    private static func signedOut(_ error: Error) -> Bool {
        if case GoogleAuth.Failure.signedOut = error { return true }
        if case MicrosoftAuth.Failure.signedOut = error { return true }
        return (error as? ImapError)?.isSignedOut == true
    }

    // ── Live ─────────────────────────────────────────────────────────────────

    /** Keeps new mail coming while the app is open (Gmail's and Outlook's pushes through the relay, IMAP's IDLE); only the former in the background. */
    func watch(pushTopic: String?, relayOnly: Bool = false) async {
        for mailbox in store.shownMailboxes where !mailbox.signedOut && watching[mailbox.email] == nil && (!relayOnly || mailbox.capabilities.relayPush) {
            let email = mailbox.email
            var task: Task<Void, Never>?
            _ = try? await run(email) { provider, state, _ in
                task = await provider.watch(pushTopic: pushTopic, &state) { [weak self] in
                    Task { await self?.sync(email, notify: true) }
                }
                return MailDelta()
            }
            if let task { watching[email] = task }
        }
    }

    /** The app went to the background: IDLE and polling stop (Gmail's and Outlook's pushes carry on through the relay). */
    func stopWatching() {
        for task in watching.values { task.cancel() }
        watching = [:]
    }

    // ── Folders and search ───────────────────────────────────────────────────

    static func key(_ folder: Folder) -> String {
        switch folder {
        case .label(let id, _): "label:\(id)"
        default: folder.title
        }
    }

    /** Whether a folder has more on the server than has been loaded. */
    func hasMore(_ folder: Folder, scope: String?) -> Bool {
        mailboxes(scope).contains { states[$0]?.pages[Self.key(folder)] != "" }
    }

    /** Where the folder's pages got to in each mailbox of `scope`; a new page changes it. */
    func cursor(_ folder: Folder, scope: String?) -> String {
        mailboxes(scope).map { states[$0]?.pages[Self.key(folder)] ?? "" }.joined(separator: " ")
    }

    /** The folder's threads its list shows: in each mailbox, down to where its pages reached (MailboxState.lists). */
    func listed(_ threads: [MailThread], in folder: Folder) -> [MailThread] {
        let key = Self.key(folder)
        let paged = Set(mailboxes(nil))
        return threads.filter { !paged.contains($0.mailbox) || states[$0.mailbox]?.lists($0, in: key) != false }
    }

    /** The folder's next page in each mailbox of `scope` (its first, the first time). */
    func loadMore(_ folder: Folder, scope: String?) async {
        await loadMore(folder, in: mailboxes(scope))
    }

    /** A page on opening the folder where none yet says where its list ends, before the list gets there (not before a first sync). */
    func open(_ folder: Folder, scope: String?) async {
        await waitForCache()
        let key = Self.key(folder)
        await loadMore(folder, in: mailboxes(scope).filter { states[$0]?.unbounded(key) == true })
    }

    private func loadMore(_ folder: Folder, in emails: [String]) async {
        await waitForCache()
        let key = Self.key(folder)
        for email in emails where states[email]?.pages[key] != "" && paging.insert("\(email) \(key)").inserted {
            _ = try? await run(email) { provider, state, known in try await provider.loadMore(folder, &state, known: known) }
            paging.remove("\(email) \(key)")
        }
    }

    /** The servers' search, in each mailbox of `scope`; answers the matching thread ids. */
    func search(_ query: String, scope: String?) async -> [String] {
        await waitForCache()
        var found: [String] = []
        for email in mailboxes(scope) {
            guard let (ids, threads) = try? await provider(email).search(query, known: store.allThreads(of: email)) else { continue }
            store.upsert(threads: threads)
            found += ids
        }
        return found
    }

    private func mailboxes(_ scope: String?) -> [String] {
        store.shownMailboxes.filter { !$0.signedOut && (scope == nil || $0.email == scope) }.map(\.email)
    }

    // ── Writing changes ──────────────────────────────────────────────────────

    /** Writes a change the store already shows; if the server refuses, the thread is reloaded as it has it. */
    func apply(_ change: MailStore.Change, to thread: MailThread) {
        guard store.mailbox(thread.mailbox)?.signedOut == false else { return }
        let email = thread.mailbox
        Task {
            do {
                try await run(email) { provider, state, known in
                    try await provider.apply(change, to: known.first(where: { $0.id == thread.id }) ?? thread, &state)
                }
            } catch {
                _ = try? await run(email) { provider, state, known in try await provider.refresh(thread, &state, known: known) }
            }
        }
    }

    /** Sends (or keeps in Drafts) a message the store already shows, then shows the server's copy of its thread. */
    func write(_ draft: Draft, asDraft: Bool) async throws {
        guard let mailbox = store.mailbox(draft.from), !mailbox.signedOut else { throw Draft.Failure.mailboxUnavailable }
        let replyTo = draft.threadID.flatMap(store.thread)
        // The message replied to (not the copy the store shows of this one, which has no Message-ID yet).
        let quoted = replyTo?.sent.last { $0.headers["Message-ID"] != nil }
        let to = Draft.people(draft.to), cc = Draft.people(draft.cc), bcc = Draft.people(draft.bcc)
        var files: [MIME.File] = []
        var size = 0
        for file in draft.files {
            let data = try await store.fileData(file, from: draft.from)
            size += data.count
            guard size <= DraftFile.limit else { throw DraftFile.Failure.tooLarge }
            files.append(MIME.File(filename: file.filename, mimeType: file.mimeType, data: data))
        }
        let html = Compose.html(draft.body, signature: mailbox.signature)
        let raw = MIME.message(
            from: mailbox.me,
            to: to,
            cc: cc,
            bcc: asDraft || mailbox.imap == nil ? bcc : [],
            files: files,
            subject: draft.subject,
            text: draft.body,
            html: html,
            inReplyTo: quoted?.headers["Message-ID"],
            references: quoted?.headers["References"],
            // Gmail stamps its own; an IMAP server keeps the message as written.
            stamped: mailbox.imap != nil
        )
        let message = Outgoing(
            raw: raw, from: mailbox.email, recipients: (to + cc + bcc).map(\.email), threadID: draft.threadID, draft: draft.messageID,
            subject: draft.subject, html: html, to: to, cc: cc, bcc: bcc, files: files, replyTo: quoted?.id
        )
        try await run(mailbox.email) { provider, state, known in
            asDraft
                ? try await provider.saveDraft(message, &state, known: known)
                : try await provider.send(message, &state, known: known)
        }
    }

    func discard(_ draft: Draft) async {
        guard let messageID = draft.messageID else { return }
        _ = try? await run(draft.from) { provider, state, _ in
            try await provider.deleteDraft(messageID, &state)
            return MailDelta()
        }
    }

    func setSignature(_ html: String, for email: String) async throws {
        let saved = try await provider(email).setSignature(html)
        if var mailbox = store.mailbox(email) {
            mailbox.signature = saved
            store.upsert(mailbox: mailbox)
        }
        scheduleSave()
    }

    /** An inline image's bytes, for the HTML that shows it. */
    func inlineImage(_ attachment: Attachment, of message: Message, in email: String) async -> Data? {
        try? await provider(email).attachment(attachment, of: message)
    }

    func attachment(_ attachment: Attachment, of message: Message, in email: String) async throws -> URL {
        let data = try await provider(email).attachment(attachment, of: message)
        let folder = URL.temporaryDirectory.appending(path: message.id.replacingOccurrences(of: "/", with: "_"), directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: attachment.filename.isEmpty ? "attachment" : URL(fileURLWithPath: attachment.filename).lastPathComponent)
        try data.write(to: url)
        return url
    }

    // ── Notifications ────────────────────────────────────────────────────────

    /** New mail found by sync, as Settings › Notifications says (core's notifier.ts). */
    private func announce(_ threads: [MailThread], before: [String: MailThread]) async {
        let mode = store.preferences.notifications
        guard mode != .off, !stopped, !Task.isCancelled else { return }
        for thread in threads {
            guard !stopped, !Task.isCancelled, store.preferences.notifications != .off else { return }
            guard !forgotten.contains(thread.mailbox), store.mailbox(thread.mailbox) != nil else { continue }
            if pushMailboxes.contains(thread.mailbox.lowercased()) { continue }
            let known = Set(before[thread.id]?.messages.map(\.id) ?? [])
            let arrived = thread.messages.filter { !known.contains($0.id) && $0.unread && !$0.draft }
            guard let message = arrived.last else { continue }
            if mode == .inbox && !thread.labels.contains("INBOX") { continue }
            let content = UNMutableNotificationContent()
            content.title = message.from.label
            content.subtitle = thread.subject
            content.body = message.snippet
            content.sound = .default
            content.threadIdentifier = thread.id
            content.userInfo = ["thread": thread.id, "mailbox": thread.mailbox]
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: message.id, content: content, trigger: nil)
            )
        }
    }
}

/** What the composer's plain text becomes as HTML, with the mailbox's signature as Gmail keeps it. */
enum Compose {
    static func html(_ text: String, signature: String) -> String {
        let escape = { (s: String) in
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\n", with: "<br>")
        }
        // The composer shows the signature as text; send Gmail's formatted one in its place.
        let plain = Signature.plainText(signature)
        if !plain.isEmpty, let range = text.range(of: plain) {
            return "<div dir=\"ltr\">\(escape(String(text[..<range.lowerBound])))\(signature)\(escape(String(text[range.upperBound...])))</div>"
        }
        return "<div dir=\"ltr\">\(escape(text))</div>"
    }
}
