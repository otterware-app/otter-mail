import Foundation

/**
 * An IMAP mailbox behind `MailProvider`, as docs/imap.md designs it:
 *
 * - Folders are labels: INBOX → `INBOX`, \Sent → `SENT`, \Trash → `TRASH`,
 *   \Junk → `SPAM`; Drafts are drafts and the Archive carries no label (as
 *   archived mail in Gmail); any other folder is a label named by its path.
 *   A message sits in one folder, so labeling, archiving and trashing move it.
 * - Flags: no \Seen is unread, \Flagged is starred.
 * - Messages are `<uidvalidity>:<uid>:<folder>`; threads join by the root of
 *   their References, when the subject agrees (anyone can write References).
 * - \Deleted mail is as good as gone: without UIDPLUS, what we delete can
 *   stay marked until the folder is expunged (ImapClient.delete).
 * - Each folder synced keeps its UIDVALIDITY, UIDNEXT and HIGHESTMODSEQ: new
 *   mail is what's past UIDNEXT, flag changes come since the mod-sequence
 *   (CONDSTORE/QRESYNC), or from a listing of what's here without it.
 * - Summaries come from ENVELOPE and BODYSTRUCTURE with the plain and HTML
 *   parts alone; attachments are fetched when opened.
 *
 * Mail goes out over SMTP, and a copy into Sent. The password stays in this
 * iPhone's Keychain and never leaves it.
 */
final class ImapProvider: MailProvider {
    let email: String
    let settings: ImapSettings
    private var client: ImapClient?
    private var usedAt = Date.distantPast
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var folders: [ImapFolder] = []
    private var roles: [Role: String] = [:]

    /** How many messages a page of a folder brings. */
    private static let page = 30

    init(email: String, settings: ImapSettings) {
        self.email = email
        self.settings = settings
        Self.migratePassword(email)
    }

    var capabilities: MailCapabilities { .imap }
    var takesTurns: Bool { true }

    // ── The password ─────────────────────────────────────────────────────────

    private static func key(_ email: String) -> String { "imap-password:\(email.lowercased())" }
    static func password(_ email: String) -> String? { Keychain.migrateShared(key(email)); return Keychain.get(key(email)) }
    /** Kept on this iPhone alone: not in backups, nor restored to another device. */
    static func setPassword(_ password: String?, for email: String) { Keychain.set(key(email), password, thisDeviceOnly: true); if password == nil { Keychain.removeLegacy(key(email)) } }
    /** A password kept before it was this iPhone's alone. */
    static func migratePassword(_ email: String) { Keychain.migrateShared(key(email)); Keychain.makeThisDeviceOnly(key(email)) }

    /** Logs in to the IMAP and SMTP servers, to check settings before they're saved. */
    static func verify(_ settings: ImapSettings, password: String) async throws {
        let client = try await ImapClient.connect(settings.imap, username: settings.username, auth: .password(password))
        await client.logout()
        try await SMTP.verify(settings.smtp, username: settings.username, auth: .password(password))
    }

    // ── The connection ───────────────────────────────────────────────────────

    /** Runs `body` on the connection, a job at a time (jobs open folders, so they can't interleave). */
    private func session<T>(_ body: (ImapClient) async throws -> T) async throws -> T {
        if busy { await withCheckedContinuation { waiting.append($0) } } else { busy = true }
        defer { if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() } }
        let client = try await connection()
        do {
            let result = try await body(client)
            usedAt = .now
            return result
        } catch {
            // The server said no: the connection is fine. Anything else: start over next time.
            if case ImapError.server = error {} else {
                client.close()
                self.client = nil
            }
            throw error
        }
    }

    private func connection() async throws -> ImapClient {
        if let client {
            // One left alone may have been dropped while the app slept.
            if usedAt > .now.addingTimeInterval(-60) { return client }
            if (try? await client.noop()) != nil { return client }
            client.close()
            self.client = nil
        }
        guard let password = Self.password(email) else { throw ImapError.signedOut }
        let client = try await ImapClient.connect(settings.imap, username: settings.username, auth: .password(password))
        self.client = client
        folders = try await client.list().filter { $0.attributes.isDisjoint(with: ["\\noselect", "\\nonexistent"]) }
        findRoles()
        return client
    }

    // ── Folders ──────────────────────────────────────────────────────────────

    private enum Role: String, CaseIterable {
        case inbox, sent, drafts, trash, junk, archive
    }

    private func refreshFolders(_ client: ImapClient) async throws {
        folders = try await client.list().filter { $0.attributes.isDisjoint(with: ["\\noselect", "\\nonexistent"]) }
        findRoles()
    }

    /** Which folder is which: by its special-use attribute (RFC 6154), else by its usual names. */
    private func findRoles() {
        let attributes: [Role: [String]] = [.sent: ["\\sent"], .drafts: ["\\drafts"], .trash: ["\\trash"], .junk: ["\\junk"], .archive: ["\\archive", "\\all"]]
        let names: [Role: [String]] = [
            .sent: ["sent", "sent items", "sent messages", "sent mail"],
            .drafts: ["drafts", "draft"],
            .trash: ["trash", "deleted items", "deleted messages", "bin"],
            .junk: ["junk", "spam", "junk e-mail", "junk email", "bulk mail"],
            .archive: ["archive", "archives"],
        ]
        roles = [.inbox: folders.first { $0.path.uppercased() == "INBOX" }?.path ?? "INBOX"]
        for role in Role.allCases where role != .inbox {
            roles[role] = attributes[role]!.lazy.compactMap { attribute in self.folders.first { $0.attributes.contains(attribute) }?.path }.first
                ?? folders.first { names[role]!.contains(Self.leaf($0).lowercased()) }?.path
        }
    }

    /** A role's folder, created when the server has none (a first message sent, trashed, …). */
    private func path(_ role: Role, _ client: ImapClient) async throws -> String {
        if let path = roles[role] { return path }
        let name = role.rawValue.capitalized
        do {
            try await client.create(name)
        } catch ImapError.server {
            // Some servers keep every folder under INBOX ("INBOX.Sent").
            try await client.create("INBOX\(folders.first?.delimiter ?? ".")\(name)")
        }
        try await refreshFolders(client)
        guard let path = roles[role] else { throw ImapError.server("Couldn't make a \(name) folder.") }
        return path
    }

    private func role(_ path: String) -> Role? { roles.first { $0.value == path }?.key }

    /** The label a message in `path` wears (nil in Drafts and the Archive). */
    private func label(_ path: String) -> String? {
        switch role(path) {
        case .inbox: "INBOX"
        case .sent: "SENT"
        case .trash: "TRASH"
        case .junk: "SPAM"
        case .drafts, .archive: nil
        case nil: path
        }
    }

    private func labels(of thread: MailThread) -> Set<String> {
        Set(thread.messages.compactMap { ImapID($0.id).flatMap { label($0.path) } })
    }

    /** The folder a sidebar entry shows. */
    private func path(_ folder: Folder) -> String? {
        switch folder {
        case .inbox: roles[.inbox]
        case .sent: roles[.sent]
        case .drafts: roles[.drafts]
        case .junk: roles[.junk]
        case .trash: roles[.trash]
        case .allMail: roles[.archive]
        case .label(let id, _): id
        case .starred, .important: nil
        }
    }

    /** The sidebar entry that shows `path` (its key keeps where the folder's pages got to). */
    private func folder(_ path: String) -> Folder {
        switch role(path) {
        case .inbox: .inbox
        case .sent: .sent
        case .drafts: .drafts
        case .junk: .junk
        case .trash: .trash
        case .archive: .allMail
        case nil: .label(id: path, name: path)
        }
    }

    func labels() async throws -> [MailLabel] {
        if folders.isEmpty { try await session { try await refreshFolders($0) } }
        let special = Set(roles.values)
        return folders.filter { !special.contains($0.path) }
            .map { MailLabel(id: $0.path, name: Self.name($0), color: nil) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /** A folder's name as a label's: decoded, "/" between levels, without the "INBOX." some servers put first. */
    private static func name(_ folder: ImapFolder) -> String {
        let decoded = MailDecoding.folderName(folder.path)
        var parts = folder.delimiter.map { decoded.components(separatedBy: $0) } ?? [decoded]
        if parts.count > 1, parts[0].uppercased() == "INBOX" { parts.removeFirst() }
        return parts.joined(separator: "/")
    }

    private static func leaf(_ folder: ImapFolder) -> String {
        name(folder).split(separator: "/").last.map(String.init) ?? folder.path
    }

    // ── Syncing ──────────────────────────────────────────────────────────────

    /** What a sync found, before it's folded into threads. */
    private struct Changes {
        var new: [Fetched] = []
        /** Message id → its flags now (lowercased). */
        var flags: [String: Set<String>] = [:]
        var gone: Set<String> = []
    }

    func sync(_ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        try await session { client in
            try await refreshFolders(client)
            var changes = Changes()
            if state.folders == nil {
                // The first time: the newest of the inbox, and of Sent and Drafts so replies join their threads.
                state.folders = [:]
                for role in [Role.inbox, .sent, .drafts] {
                    if let path = roles[role] { try await loadPage(path, &state, client, &changes) }
                }
            } else {
                try await catchUp(&state, known: known, client, &changes)
            }
            return merge(known, changes)
        }
    }

    /** Every folder synced so far, caught up. */
    private func catchUp(_ state: inout MailboxState, known: [MailThread], _ client: ImapClient, _ changes: inout Changes) async throws {
        let here = known.flatMap(\.messages).compactMap { ImapID($0.id) }
        for path in (state.folders ?? [:]).keys.sorted() {
            let mine = here.filter { $0.path == path }
            guard folders.contains(where: { $0.path == path }) else {
                // The folder is gone (deleted or renamed elsewhere), and its mail with it.
                changes.gone.formUnion(mine.map(\.id))
                state.folders?[path] = nil
                continue
            }
            try await catchUp(path, mine: mine, &state, client, &changes)
        }
    }

    private func catchUp(_ path: String, mine: [ImapID], _ state: inout MailboxState, _ client: ImapClient, _ changes: inout Changes) async throws {
        guard var saved = state.folders?[path] else { return }
        let capabilities = await client.capabilities
        let condstore = capabilities.contains("CONDSTORE") || capabilities.contains("QRESYNC")
        let qresync = capabilities.contains("QRESYNC")
        // Nothing new: servers with CONDSTORE say so without the folder being opened (the open one's STATUS can be stale).
        if condstore, saved.highestModSeq != nil, await client.selected != path, let status = try? await client.status(path),
           status.uidValidity == saved.uidValidity, status.uidNext == saved.uidNext, status.highestModSeq == saved.highestModSeq {
            return
        }
        let status = try await client.select(path)
        guard status.uidValidity == saved.uidValidity else {
            // The folder was rebuilt: its UIDs mean nothing now. Start it over.
            changes.gone.formUnion(mine.map(\.id))
            state.folders?[path] = nil
            return try await loadPage(path, &state, client, &changes)
        }
        if status.uidNext > saved.uidNext {
            // New mail (the newest couple of hundred, after a flood).
            let uids = try await client.search("UID \(saved.uidNext):* UNDELETED").filter { $0 >= saved.uidNext }.suffix(200)
            changes.new += try await messages(Array(uids), in: path, validity: status.uidValidity, client)
        }
        let uids = Set(mine.filter { $0.validity == status.uidValidity }.map(\.uid))
        if let low = uids.min() {
            // Flags changed, and mail gone, among what's here.
            let responses: [ImapResponse]
            var present: Set<UInt32>?
            if condstore, let modseq = saved.highestModSeq {
                responses = try await client.fetch("\(low):*", "(UID FLAGS)", modifiers: qresync ? "(CHANGEDSINCE \(modseq) VANISHED)" : "(CHANGEDSINCE \(modseq))")
                if !qresync { present = Set(try await client.search("UID \(low):* UNDELETED")) }
            } else {
                responses = try await client.fetch("\(low):*", "(UID FLAGS)")
                present = Set(responses.compactMap { response in
                    let items = response.values.first?.pairs ?? [:]
                    return Self.isDeleted(items) ? nil : items["UID"]?.number.map { UInt32(clamping: $0) }
                })
            }
            for response in responses {
                if response.kind == "VANISHED" {
                    let vanished = imapUIDs(response.values.last?.text ?? "")
                    changes.gone.formUnion(vanished.map { ImapID(validity: status.uidValidity, uid: $0, path: path).id })
                    continue
                }
                let items = response.values.first?.pairs ?? [:]
                guard let uid = items["UID"]?.number, let flags = items["FLAGS"] else { continue }
                let id = ImapID(validity: status.uidValidity, uid: UInt32(clamping: uid), path: path).id
                if Self.isDeleted(items) { changes.gone.insert(id) } else { changes.flags[id] = Set(flags.list.compactMap { $0.text?.lowercased() }) }
            }
            if let present {
                changes.gone.formUnion(uids.subtracting(present).map { ImapID(validity: status.uidValidity, uid: $0, path: path).id })
            }
        }
        saved.uidNext = status.uidNext
        saved.highestModSeq = status.highestModSeq
        state.folders?[path] = saved
    }

    /** A folder's next page, back from the oldest loaded (its newest, the first time); the folder syncs from then on. */
    private func loadPage(_ path: String, _ state: inout MailboxState, _ client: ImapClient, _ changes: inout Changes) async throws {
        let status = try await client.select(path)
        var saved = state.folders?[path]
            ?? ImapFolderState(uidValidity: status.uidValidity, uidNext: status.uidNext, highestModSeq: status.highestModSeq, oldest: status.uidNext)
        guard saved.uidValidity == status.uidValidity else { return } // The next sync starts it over.
        let older = saved.oldest > 1 ? try await client.search("UID 1:\(saved.oldest - 1) UNDELETED").filter { $0 < saved.oldest } : []
        let page = older.sorted().suffix(Self.page)
        let fetched = try await messages(Array(page), in: path, validity: status.uidValidity, client)
        changes.new += fetched
        saved.oldest = page.min() ?? saved.oldest
        if state.folders == nil { state.folders = [:] }
        state.folders?[path] = saved
        state.paged(MailSync.key(folder(path)), next: older.count > page.count ? "more" : nil, oldest: fetched.map(\.message.date).min())
    }

    /** Starts syncing a folder from now, before mail is moved or written there. */
    @discardableResult
    private func track(_ path: String, _ state: inout MailboxState, _ client: ImapClient) async throws -> UInt32 {
        if let saved = state.folders?[path] { return saved.uidValidity }
        let status = try await client.select(path)
        if state.folders == nil { state.folders = [:] }
        state.folders?[path] = ImapFolderState(uidValidity: status.uidValidity, uidNext: status.uidNext, highestModSeq: nil, oldest: status.uidNext)
        return status.uidValidity
    }

    func loadMore(_ folder: Folder, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        try await session { client in
            guard let path = path(folder), folders.contains(where: { $0.path == path }) else {
                state.pages[MailSync.key(folder)] = ""
                return MailDelta()
            }
            var changes = Changes()
            try await loadPage(path, &state, client, &changes)
            return merge(known, changes)
        }
    }

    /** Search runs on what's here (MailStore.search), as core's does on its cache. */
    func search(_ query: String, known: [MailThread]) async throws -> (ids: [String], threads: [MailThread]) { ([], []) }

    // ── Messages ─────────────────────────────────────────────────────────────

    /** A message as fetched, with what threading it needs. */
    private struct Fetched {
        var message: Message
        var subject: String
        /** The root of its References: what its thread is keyed by. */
        var root: String
        var bodies: [ImapBodyPart]
    }

    /** Summaries of `uids` in the open folder, with their words (plain and HTML parts only). */
    private func messages(_ uids: [UInt32], in path: String, validity: UInt32, _ client: ImapClient) async throws -> [Fetched] {
        guard !uids.isEmpty else { return [] }
        let responses = try await client.fetch(
            imapSet(uids),
            "(UID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (REFERENCES LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST)])"
        )
        let drafts = role(path) == .drafts
        var fetched = responses.compactMap { Self.fetched($0.values.first?.pairs ?? [:], path: path, validity: validity, inDrafts: drafts) }
        // One FETCH for the words of every message whose parts sit in the same places.
        let groups = Dictionary(grouping: fetched.indices) { fetched[$0].bodies.map(\.section) }
        for (sections, indices) in groups where !sections.isEmpty {
            let byUID = Dictionary(indices.map { (ImapID(fetched[$0].message.id)!.uid, $0) }) { a, _ in a }
            let items = sections.map { "BODY.PEEK[\($0)]" }.joined(separator: " ")
            for response in try await client.fetch(imapSet(byUID.keys), "(UID \(items))") {
                let pairs = response.values.first?.pairs ?? [:]
                guard let uid = pairs["UID"]?.number, let index = byUID[UInt32(clamping: uid)] else { continue }
                for part in fetched[index].bodies {
                    guard let data = pairs["BODY[\(part.section)]"]?.data else { continue }
                    let text = MailDecoding.text(MailDecoding.transfer(data, encoding: part.encoding), charset: part.params["charset"])
                        .replacingOccurrences(of: "\r\n", with: "\n")
                    if part.type == "text/html" { fetched[index].message.html = text } else { fetched[index].message.text = text }
                }
                if fetched[index].message.text.isEmpty, let html = fetched[index].message.html {
                    fetched[index].message.text = HTMLText.plain(html)
                }
            }
        }
        return fetched
    }

    private static let internalDate = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "d-MMM-yyyy HH:mm:ss Z"
        return formatter
    }()

    /** A FETCH's items (ENVELOPE, BODYSTRUCTURE, …) as a message. */
    private static func fetched(_ items: [String: ImapValue], path: String, validity: UInt32, inDrafts: Bool) -> Fetched? {
        guard let uid = items["UID"]?.number, !isDeleted(items) else { return nil }
        let flags = Set(items["FLAGS"]?.list.compactMap { $0.text?.lowercased() } ?? [])
        let envelope = items["ENVELOPE"]?.list ?? []
        let field = { (i: Int) in i < envelope.count ? envelope[i] : .none }
        let block = items.first { $0.key.hasPrefix("BODY[HEADER") }?.value.text ?? ""
        let messageID = field(9).text
        let references = MailDecoding.header("References", in: block)
        let ids = { (text: String?) in (text ?? "").matches(of: /<[^>]+>/).map { String($0.output) } }
        let root = ids(references).first ?? ids(field(8).text).first ?? messageID ?? "\(validity):\(uid):\(path)"

        let parts = ImapBodyPart.leaves(items["BODYSTRUCTURE"] ?? .none)
        let bodies = [parts.first { $0.isBody && $0.type == "text/plain" }, parts.first { $0.isBody && $0.type == "text/html" }].compactMap { $0 }
        let isInline = { (part: ImapBodyPart) in part.contentID != nil && part.disposition != "attachment" && part.type.hasPrefix("image/") }
        let attachment = { (part: ImapBodyPart) in
            Attachment(id: "\(part.section) \(part.encoding)", filename: part.filename ?? "", mimeType: part.type, size: part.size, contentID: isInline(part) ? part.contentID : nil)
        }
        let files = parts.filter { !$0.isBody && ($0.disposition == "attachment" || $0.filename != nil || isInline($0)) }

        var headers: [String: String] = [:]
        if let messageID { headers["Message-ID"] = messageID }
        let bcc = imapAddresses(field(7))
        if !bcc.isEmpty { headers["Bcc"] = bcc.map(Draft.format).joined(separator: ", ") }
        for name in ["References", "List-Unsubscribe", "List-Unsubscribe-Post"] {
            if let value = MailDecoding.header(name, in: block) { headers[name] = value }
        }
        let inline = files.filter(isInline).map(attachment)
        let message = Message(
            id: ImapID(validity: validity, uid: UInt32(clamping: uid), path: path).id,
            from: imapAddresses(field(2)).first ?? Person(name: "", email: ""),
            to: imapAddresses(field(5)),
            cc: imapAddresses(field(6)),
            date: (items["INTERNALDATE"]?.text).flatMap { internalDate.date(from: $0.trimmingCharacters(in: .whitespaces)) } ?? .now,
            text: "",
            html: nil,
            attachments: files.filter { !isInline($0) }.map(attachment),
            inline: inline.isEmpty ? nil : inline,
            unread: !flags.contains("\\seen"),
            starred: flags.contains("\\flagged"),
            draft: inDrafts || flags.contains("\\draft"),
            headers: headers
        )
        let subject = field(1).text.map(MailDecoding.words) ?? ""
        return Fetched(message: message, subject: subject.isEmpty ? "(no subject)" : subject, root: root, bodies: bodies)
    }

    /** Marked \Deleted: on its way out (see ImapClient.delete), so not shown. */
    private static func isDeleted(_ items: [String: ImapValue]) -> Bool {
        items["FLAGS"]?.list.contains { $0.text?.lowercased() == "\\deleted" } ?? false
    }

    /** A subject without its "Re:", "Fwd:", "AW:", "SV:"…: what a thread's messages share. */
    static func topic(_ subject: String) -> String {
        var topic = subject.trimmingCharacters(in: .whitespaces)
        while let prefix = topic.prefixMatch(of: /(?i)(re|fwd?|aw|sv|wg)(\[\d+\])?\s*:\s*/) {
            topic = String(topic[prefix.range.upperBound...])
        }
        topic = topic.lowercased()
        return topic == "(no subject)" ? "" : topic
    }

    /** Folds what a sync found into the mailbox's threads: whole threads that changed, and those left empty. */
    private func merge(_ known: [MailThread], _ changes: Changes) -> MailDelta {
        var threads = Dictionary(known.map { ($0.id, $0) }) { a, _ in a }
        var owner: [String: String] = [:]
        for thread in known { for message in thread.messages { owner[message.id] = thread.id } }
        var touched = Set<String>()
        for id in changes.gone {
            guard let thread = owner[id] else { continue }
            threads[thread]?.messages.removeAll { $0.id == id }
            touched.insert(thread)
        }
        for (id, flags) in changes.flags {
            guard let thread = owner[id], let i = threads[thread]?.messages.firstIndex(where: { $0.id == id }) else { continue }
            let (unread, starred) = (!flags.contains("\\seen"), flags.contains("\\flagged"))
            guard threads[thread]!.messages[i].unread != unread || threads[thread]!.messages[i].starred != starred else { continue }
            threads[thread]!.messages[i].unread = unread
            threads[thread]!.messages[i].starred = starred
            touched.insert(thread)
        }
        for fetched in changes.new {
            var id = owner[fetched.message.id] ?? "\(email) \(fetched.root)"
            // References (and Message-IDs) are the sender's to write: a thread is only joined on the same subject.
            if owner[fetched.message.id] == nil, let thread = threads[id], Self.topic(thread.subject) != Self.topic(fetched.subject) {
                id = "\(email) \(fetched.message.id)"
            }
            if threads[id] == nil {
                threads[id] = MailThread(id: id, mailbox: email, subject: fetched.subject, labels: [], messages: [])
            }
            threads[id]!.messages.removeAll { $0.id == fetched.message.id }
            // A thread is called what its first message is (a reply found first gave it its "Re:").
            if threads[id]!.messages.allSatisfy({ $0.date > fetched.message.date }) { threads[id]!.subject = fetched.subject }
            threads[id]!.messages.append(fetched.message)
            owner[fetched.message.id] = id
            touched.insert(id)
        }
        var delta = MailDelta()
        for id in touched {
            guard var thread = threads[id] else { continue }
            if thread.messages.isEmpty {
                delta.removed.insert(id)
                continue
            }
            thread.messages.sort { $0.date < $1.date }
            thread.labels = labels(of: thread)
            delta.threads.append(thread)
        }
        return delta
    }

    // ── Changing ─────────────────────────────────────────────────────────────

    func apply(_ change: MailStore.Change, to thread: MailThread, _ state: inout MailboxState) async throws -> MailDelta {
        let ids = thread.messages.compactMap { ImapID($0.id) }
        return try await session { client in
            var moved: [String: String?] = [:]
            switch change {
            case .modify(let add, let remove):
                if add.contains("UNREAD") { try await flag(ids, #"-FLAGS.SILENT (\Seen)"#, client) }
                if remove.contains("UNREAD") { try await flag(ids, #"+FLAGS.SILENT (\Seen)"#, client) }
                if remove.contains("STARRED") { try await flag(ids, #"-FLAGS.SILENT (\Flagged)"#, client) }
                let adding = add.filter { $0 != "UNREAD" && $0 != "STARRED" }
                let removing = Set(remove.filter { $0 != "UNREAD" && $0 != "STARRED" })
                guard !adding.isEmpty || !removing.isEmpty else { break }
                // Into the label's folder; out of the inbox is to the Archive; out of another folder, back to the inbox.
                let destination = if let label = adding.first {
                    try await path(label: label, client)
                } else if removing.contains("INBOX") {
                    try await path(.archive, client)
                } else {
                    roles[.inbox]
                }
                // What moves: what's in the folders the change takes it out of, else what's filed (not Sent, Drafts, Trash or Junk).
                let sources = removing.isEmpty
                    ? ids.filter { [nil, .inbox, .archive].contains(role($0.path)) }
                    : ids.filter { removing.contains(label($0.path) ?? "") }
                if let destination { moved = try await move(sources, to: destination, &state, client) }
            case .star(let message):
                if let id = ImapID(message) { try await flag([id], #"+FLAGS.SILENT (\Flagged)"#, client) }
            case .trash:
                let trash = try await path(.trash, client)
                let trashing = ids.filter { $0.path != trash }
                moved = try await move(trashing, to: trash, &state, client)
                // Where each came from, for Restore; kept with the mailbox's state, so it outlives a relaunch.
                var origins = state.trashedFrom ?? [:]
                for id in trashing {
                    if let new = moved[id.id] ?? nil { origins[new] = id.path }
                }
                state.trashedFrom = origins
            case .untrash:
                var origins = state.trashedFrom ?? [:]
                let trashed = ids.filter { role($0.path) == .trash }
                // Back where it came from while that folder's still there, else to the inbox.
                let inbox = roles[.inbox] ?? "INBOX"
                let destination = { (id: ImapID) -> String in
                    guard let origin = origins[id.id], self.folders.contains(where: { $0.path == origin }) else { return inbox }
                    return origin
                }
                for (path, group) in Dictionary(grouping: trashed, by: destination) {
                    moved.merge(try await move(group, to: path, &state, client)) { $1 }
                }
                for id in trashed { origins[id.id] = nil }
                state.trashedFrom = origins
            case .delete:
                // Only what's in Trash or Junk (where it's offered): the rest of the thread stays.
                let doomed = ids.filter { [.trash, .junk].contains(role($0.path)) }
                if var origins = state.trashedFrom {
                    for id in doomed { origins[id.id] = nil }
                    state.trashedFrom = origins
                }
                for (path, group) in Dictionary(grouping: doomed, by: \.path) {
                    try await client.open(path)
                    try await client.delete(group.map(\.uid))
                }
                var kept = thread
                kept.messages.removeAll { message in doomed.contains { $0.id == message.id } }
                guard !kept.messages.isEmpty else { return MailDelta(removed: [thread.id]) }
                kept.labels = labels(of: kept)
                return MailDelta(threads: [kept])
            }
            guard !moved.isEmpty else { return MailDelta() }
            // The messages under their new ids (those the server didn't say come with the next sync).
            var updated = thread
            updated.messages = thread.messages.compactMap { message in
                guard let new = moved[message.id] else { return message }
                guard let new else { return nil }
                var message = message
                message.id = new
                return message
            }
            guard !updated.messages.isEmpty else { return MailDelta(removed: [thread.id]) }
            updated.labels = labels(of: updated)
            return MailDelta(threads: [updated])
        }
    }

    /** A label's folder: a system label's (made if missing), or the folder a user label is. */
    private func path(label: String, _ client: ImapClient) async throws -> String? {
        switch label {
        case "INBOX": roles[.inbox]
        case "SENT": try await path(.sent, client)
        case "SPAM": try await path(.junk, client)
        case "TRASH": try await path(.trash, client)
        default: folders.contains { $0.path == label } ? label : nil
        }
    }

    private func flag(_ ids: [ImapID], _ change: String, _ client: ImapClient) async throws {
        for (path, group) in Dictionary(grouping: ids, by: \.path) {
            try await client.open(path)
            try await client.store(group.map(\.uid), change)
        }
    }

    /** Moves messages to `destination`; answers each one's id there (nil when the server didn't say). */
    private func move(_ ids: [ImapID], to destination: String, _ state: inout MailboxState, _ client: ImapClient) async throws -> [String: String?] {
        let movers = ids.filter { $0.path != destination }
        guard !movers.isEmpty else { return [:] }
        let validity = try await track(destination, &state, client)
        var out: [String: String?] = [:]
        for (path, group) in Dictionary(grouping: movers, by: \.path) {
            try await client.open(path)
            let uids = try await client.move(group.map(\.uid), to: destination)
            for id in group {
                out.updateValue(uids[id.uid].map { ImapID(validity: validity, uid: $0, path: destination).id }, forKey: id.id)
            }
        }
        return out
    }

    func refresh(_ thread: MailThread, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        let ids = thread.messages.compactMap { ImapID($0.id) }
        return try await session { client in
            var flags: [String: Set<String>] = [:]
            for (path, group) in Dictionary(grouping: ids, by: \.path) {
                guard (try? await client.select(path)) != nil else { continue }
                for response in try await client.fetch(imapSet(group.map(\.uid)), "(UID FLAGS)") {
                    let items = response.values.first?.pairs ?? [:]
                    guard let uid = items["UID"]?.number, !Self.isDeleted(items) else { continue }
                    let id = ImapID(validity: group[0].validity, uid: UInt32(clamping: uid), path: path).id
                    flags[id] = Set(items["FLAGS"]?.list.compactMap { $0.text?.lowercased() } ?? [])
                }
            }
            var updated = thread
            updated.messages = thread.messages.compactMap { message in
                guard let flags = flags[message.id] else { return nil }
                var message = message
                message.unread = !flags.contains("\\seen")
                message.starred = flags.contains("\\flagged")
                return message
            }
            guard !updated.messages.isEmpty else { return MailDelta(removed: [thread.id]) }
            updated.labels = labels(of: updated)
            return MailDelta(threads: [updated])
        }
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    func send(_ message: Outgoing, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        guard let password = Self.password(email) else { throw ImapError.signedOut }
        try await SMTP.send(message.raw, from: message.from, to: message.recipients, server: settings.smtp, username: settings.username, auth: .password(password))
        // Sent: filing a copy is a courtesy, and a failure there isn't a failure to send.
        do {
            return try await session { client in
                // Gmail and Outlook file what their SMTP sends; a copy would make two.
                if !Self.filesSentMail(settings.smtp.host) {
                    let sent = try await path(.sent, client)
                    try await track(sent, &state, client)
                    _ = try await client.append(message.raw, to: sent, flags: #"\Seen"#)
                }
                if let draft = message.draft.flatMap(ImapID.init) { try await deleteDraft(draft, known: known, client) }
                var changes = Changes()
                try await catchUp(&state, known: known, client, &changes)
                return merge(known, changes)
            }
        } catch {
            return MailDelta()
        }
    }

    private static func filesSentMail(_ host: String) -> Bool {
        let host = host.lowercased()
        return ["gmail.com", "googlemail.com", "office365.com", "outlook.com"].contains { host.hasSuffix($0) }
    }

    func saveDraft(_ message: Outgoing, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        try await session { client in
            let drafts = try await path(.drafts, client)
            try await track(drafts, &state, client)
            _ = try await client.append(message.raw, to: drafts, flags: #"\Draft \Seen"#)
            if let previous = message.draft.flatMap(ImapID.init) { try await deleteDraft(previous, known: known, client) }
            var changes = Changes()
            try await catchUp(&state, known: known, client, &changes)
            return merge(known, changes)
        }
    }

    func deleteDraft(_ messageID: String, _ state: inout MailboxState) async throws {
        guard let id = ImapID(messageID) else { return }
        try await session { client in try await deleteDraft(id, known: [], client) }
    }

    /**
     * Deletes a draft's earlier version, only if its UID still names it: the
     * folder's UIDVALIDITY unchanged, a draft, and (when the copy here has
     * one) the same Message-ID.
     */
    private func deleteDraft(_ id: ImapID, known: [MailThread], _ client: ImapClient) async throws {
        guard try await client.select(id.path).uidValidity == id.validity else { return }
        let response = try await client.fetch("\(id.uid)", "(UID FLAGS BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])").first
        let items = response?.values.first?.pairs ?? [:]
        let flags = items["FLAGS"]?.list.compactMap { $0.text?.lowercased() } ?? []
        guard items["UID"]?.number == UInt64(id.uid), flags.contains("\\draft") || role(id.path) == .drafts else { return }
        let expected = known.lazy.flatMap(\.messages).first { $0.id == id.id }?.headers["Message-ID"]
        if let expected = expected.flatMap(Self.messageID) {
            let header = items.first { $0.key.hasPrefix("BODY[HEADER") }?.value.text ?? ""
            guard MailDecoding.header("Message-ID", in: header).flatMap(Self.messageID) == expected else { return }
        }
        try await client.delete([id.uid])
    }

    /** A Message-ID as `<local@domain>`, or nil when it isn't one (empty, or without its brackets). */
    private static func messageID(_ text: String) -> String? {
        let text = text.trimmingCharacters(in: .whitespaces)
        return text.wholeMatch(of: /<[^<>\s]+>/) != nil ? text : nil
    }

    func attachment(_ attachment: Attachment, of message: Message) async throws -> Data {
        guard let id = ImapID(message.id), let spec = attachment.id?.split(separator: " "), spec.count == 2 else {
            throw ImapError.protocolError("No file to open.")
        }
        return try await session { client in
            try await client.open(id.path)
            let response = try await client.fetch("\(id.uid)", "(UID BODY.PEEK[\(spec[0])])").first
            guard let data = response?.values.first?.pairs["BODY[\(spec[0])]"]?.data else {
                throw ImapError.server("The file isn't on the server anymore.")
            }
            return MailDecoding.transfer(data, encoding: String(spec[1]))
        }
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    /** The server keeps no signatures: the mailbox keeps one, following the Otter account (Session, `signatures`). */
    func signature() async throws -> String? { nil }
    func setSignature(_ html: String) async throws -> String { html }

    // ── Live ─────────────────────────────────────────────────────────────────

    /**
     * IDLE on the inbox, on a connection of its own, while the app is open:
     * each change there syncs. A new IDLE every 25 minutes (servers drop them
     * after 30), reconnecting with backoff. Servers without IDLE sync when
     * the app opens or is pulled to refresh. A refused password stops it:
     * retrying would only get the account locked.
     */
    func watch(pushTopic: String?, _ state: inout MailboxState, onChange: @escaping () -> Void) async -> Task<Void, Never>? {
        guard let password = Self.password(email) else { return nil }
        let settings = settings
        let inbox = roles[.inbox] ?? "INBOX"
        return Task {
            var delay = Duration.seconds(2)
            while !Task.isCancelled {
                do {
                    let client = try await ImapClient.connect(settings.imap, username: settings.username, auth: .password(password))
                    defer { client.close() }
                    guard await client.capabilities.contains("IDLE") else { return }
                    try await client.select(inbox)
                    while !Task.isCancelled {
                        let started = ContinuousClock.now
                        if try await client.idle(for: .seconds(25 * 60)) { onChange() }
                        let lasted = ContinuousClock.now - started
                        // Only an IDLE that held a while says the server is well.
                        if lasted > .seconds(60) { delay = .seconds(2) }
                        // A server that ends every IDLE at once mustn't be asked again at once.
                        if lasted < .seconds(5) { try await Task.sleep(for: .seconds(5) - lasted) }
                    }
                } catch ImapError.authentication {
                    // The sync this starts meets the same refusal and asks for the password (MailSync).
                    onChange()
                    return
                } catch {
                    try? await Task.sleep(for: delay)
                    delay = min(delay * 2, .seconds(300))
                }
            }
        }
    }
}

/** An IMAP message's id in the app: `<uidvalidity>:<uid>:<folder path>`. */
nonisolated struct ImapID: Hashable {
    var validity: UInt32
    var uid: UInt32
    var path: String

    init(validity: UInt32, uid: UInt32, path: String) {
        self.validity = validity
        self.uid = uid
        self.path = path
    }

    init?(_ id: String) {
        let parts = id.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, let validity = UInt32(parts[0]), let uid = UInt32(parts[1]) else { return nil }
        self.init(validity: validity, uid: uid, path: String(parts[2]))
    }

    var id: String { "\(validity):\(uid):\(path)" }
}
