import Foundation

/**
 * An Outlook mailbox behind `MailProvider`, through Microsoft Graph, as
 * core's providers/outlook designs it (docs/outlook.md):
 *
 * - Folders and categories are labels (`OutlookFolders`), with core's ids.
 * - Threads are Outlook's conversations, read whole (every folder's part of
 *   them) whenever one changes, so labels always say where all of it is.
 * - Each followed folder has a delta: the inbox, Sent and Drafts from the
 *   first sync, other folders once their list is opened. A delta follows
 *   mail from a month back (or the folder's first page, if older); older
 *   pages are read once. A first sync shows the inbox's newest page at once.
 * - Messages' words, files and headers come from their MIME source, read
 *   once when they first sync.
 * - Writes are property PATCHes and moves; replies are made with
 *   `createReply`; drafts are updated in place, so their ids never change.
 * - A Graph subscription sends the mailbox's changes to the relay, whose
 *   `mail` events sync it, as Gmail's pushes do; without one, it polls.
 */
final class OutlookProvider: MailProvider {
    let email: String
    private let api: GraphAPI
    /** Where Graph should send the mailbox's changes, asked of the relay (`/v1/outlook/watch`). */
    private let watchTarget: (() async throws -> Relay.OutlookWatch)?
    private var folders: OutlookFolders?
    private var foldersAt = Date.distantPast
    /** Recently opened messages' files, so a message's inline images take one download. */
    private var sources: [String: Task<[MIMEParser.File], Error>] = [:]

    /** How many messages a page of a folder brings. */
    private static let page = 30
    /** How far back a delta follows a folder's mail, at least. */
    private static let followed: TimeInterval = 30 * 86_400

    init(email: String, api: GraphAPI, watchTarget: (() async throws -> Relay.OutlookWatch)?) {
        self.email = email
        self.api = api
        self.watchTarget = watchTarget
    }

    var capabilities: MailCapabilities { .outlook }
    /** One call at a time: a move and the thread's next read must not cross (undo, then restore). */
    var takesTurns: Bool { true }

    // ── Folders ──────────────────────────────────────────────────────────────

    /** The folder tree and categories: re-read every 2 minutes, or after mail changed (at most every 30 seconds). */
    private func mailbox(changed: Bool = false) async throws -> OutlookFolders {
        let age = Date.now.timeIntervalSince(foldersAt)
        if let folders, age < 120, !(changed && age > 30) { return folders }
        let read = try await api.folders(wellKnown: folders?.wellKnown)
        folders = read
        foldersAt = .now
        return read
    }

    func labels() async throws -> [MailLabel] { try await mailbox().labels }

    /** The label a sidebar entry stands for (nil: All Mail). */
    private static func label(_ folder: Folder) -> String? {
        switch folder {
        case .inbox: "INBOX"
        case .starred: "STARRED"
        case .sent: "SENT"
        case .drafts: "DRAFT"
        case .important: "IMPORTANT"
        case .allMail: nil
        case .junk: "SPAM"
        case .trash: "TRASH"
        case .label(let id, _): id
        }
    }

    // ── Syncing ──────────────────────────────────────────────────────────────

    func sync(_ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        let box = try await mailbox()
        var changed = Set<String>()
        if state.deltas == nil {
            // The first time: the inbox's newest page, then the inbox, Sent and Drafts followed from there.
            let inbox = box.id("inbox")
            let page: GraphAPI.Page<GraphMessage> = try await api.get(GraphAPI.path(GraphAPI.folderPath(inbox) + "/messages", [
                ("$select", "id,conversationId,receivedDateTime,parentFolderId"),
                ("$orderby", "receivedDateTime desc"),
                ("$top", String(Self.page)),
            ]))
            let messages = page.value ?? []
            changed = Set(messages.map(\.thread))
            let dates = messages.map(\.date)
            state.deltas = [:]
            for name in ["inbox", "sentitems", "drafts"] {
                changed.formUnion(try await follow(box.id(name), since: dates.min(), after: dates.max(), &state))
            }
            state.paged(MailSync.key(.inbox), next: page.nextLink, oldest: dates.min())
        } else {
            changed = try await catchUp(box, &state, known: known)
        }
        let (threads, gone) = try await self.threads(changed, known: known)
        // Counts and categories moved with the mail.
        if !changed.isEmpty { _ = try? await mailbox(changed: true) }
        return MailDelta(threads: threads, removed: gone)
    }

    /**
     * Starts following a folder's changes, from a month back or `since` if
     * older; answers the conversations of its mail newer than `after` (mail
     * that came while its page was being read).
     */
    private func follow(_ folder: String, since: Date?, after: Date?, _ state: inout MailboxState) async throws -> Set<String> {
        let from = min(since ?? .now, .now.addingTimeInterval(-Self.followed))
        let start = try await api.delta(GraphAPI.deltaStart(folder, since: from))
        state.deltas = (state.deltas ?? [:]).merging([folder: start.link]) { $1 }
        return Set(start.changed.filter { message in after.map { message.date > $0 } ?? true }.map(\.thread))
    }

    /** What changed in each followed folder: the conversations to read again. */
    private func catchUp(_ box: OutlookFolders, _ state: inout MailboxState, known: [MailThread]) async throws -> Set<String> {
        var owner: [String: String] = [:]
        for thread in known { for message in thread.messages { owner[message.id] = thread.id } }
        var changed = Set<String>()
        for (folder, link) in (state.deltas ?? [:]).sorted(by: { $0.key < $1.key }) {
            let label = box.label(ofFolder: folder)
            guard box.folders.contains(where: { $0.id == folder }) || box.wellKnown.values.contains(folder) else {
                // The folder is gone (deleted for good, or moved into Deleted Items): its mail went with it.
                state.deltas?[folder] = nil
                changed.formUnion(known.filter { $0.labels.contains("\(OutlookFolders.folderPrefix)\(folder)") }.map(\.id))
                continue
            }
            do {
                let delta = try await api.delta(link)
                changed.formUnion(delta.changed.map(\.thread))
                // Gone from the folder: moved (immutable ids keep it) or deleted; reading its thread again tells which.
                changed.formUnion(delta.removed.compactMap { owner[$0] })
                state.deltas?[folder] = delta.link
            } catch where GraphAPI.expired(error) {
                // Graph lost track: follow the folder again from now, and read again what's here of it.
                _ = try await follow(folder, since: nil, after: .now, &state)
                changed.formUnion(known.filter { thread in label.map { thread.labels.contains($0) } ?? false }.map(\.id))
            }
        }
        return changed
    }

    /** Conversations read whole: the threads they are now, and those gone (or left with nothing worth showing). */
    private func threads(_ ids: Set<String>, known: [MailThread]) async throws -> (threads: [MailThread], gone: Set<String>) {
        guard !ids.isEmpty else { return ([], []) }
        let box = try await mailbox()
        let lists = try await api.conversations(Array(ids))
        let have = Dictionary(known.flatMap(\.messages).map { ($0.id, $0) }) { a, _ in a }
        // Words are read once; a draft's change.
        let new = lists.values.joined().filter { box.isSynced($0.parentFolderId) && (have[$0.id] == nil || $0.isDraft == true) }
        let contents = try await api.contents(Array(new))
        let threads = lists.compactMap { id, messages in
            OutlookMail.thread(id, messages, mailbox: email, folders: box, contents: contents, known: have)
        }
        return (threads, ids.subtracting(threads.map(\.id)))
    }

    private func reload(_ id: String, known: [MailThread]) async throws -> MailDelta {
        let (threads, gone) = try await self.threads([id], known: known)
        return MailDelta(threads: threads, removed: gone)
    }

    func loadMore(_ folder: Folder, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        let box = try await mailbox()
        let key = MailSync.key(folder)
        let label = Self.label(folder)
        let place = label.flatMap(box.folder(ofLabel:))
        let url = state.pages[key] ?? {
            var query = [("$select", "id,conversationId,receivedDateTime,parentFolderId"), ("$top", String(Self.page))]
            // Graph can't filter and sort at once; it lists newest first anyway.
            if let filter = label.flatMap(OutlookSearch.filter) { query.append(("$filter", filter)) } else { query.append(("$orderby", "receivedDateTime desc")) }
            return GraphAPI.path(place.map { GraphAPI.folderPath($0) + "/messages" } ?? "/me/messages", query)
        }()
        let first = state.pages[key] == nil
        let page: GraphAPI.Page<GraphMessage> = try await api.get(url)
        let messages = (page.value ?? []).filter { box.isSynced($0.parentFolderId) }
        let have = Set(known.map(\.id))
        var wanted = Set(messages.map(\.thread)).subtracting(have)
        let dates = messages.map(\.date)
        // A folder is followed from its first page on, as the inbox is.
        if first, let place, state.deltas?[place] == nil {
            wanted.formUnion(try await follow(place, since: dates.min(), after: dates.max(), &state).subtracting(have))
        }
        let (threads, _) = try await self.threads(wanted, known: known)
        state.paged(key, next: page.nextLink, oldest: dates.min())
        return MailDelta(threads: threads)
    }

    func search(_ query: String, known: [MailThread]) async throws -> (ids: [String], threads: [MailThread]) {
        let box = try await mailbox()
        let search = OutlookSearch.query(query, labels: box.labels)
        // `in:` a folder is where to search; other labels are checked on each result.
        let scope = search.wanted.first { !$0.negated && box.folder(ofLabel: $0.label) != nil }
        var params = [("$select", "id,conversationId,parentFolderId,isRead,flag,importance,categories"), ("$top", "25")]
        let filters = search.wanted.filter { !$0.negated }.compactMap { OutlookSearch.filter($0.label) }
        if let kql = search.kql {
            params.append(("$search", "\"\(kql.replacingOccurrences(of: "\"", with: "\\\""))\""))
        } else if !filters.isEmpty {
            // Graph can't search and filter at once: filter only when there's nothing to search.
            params.append(("$filter", filters.joined(separator: " and ")))
        } else {
            params.append(("$orderby", "receivedDateTime desc"))
        }
        let path = scope.flatMap { box.folder(ofLabel: $0.label) }.map { GraphAPI.folderPath($0) + "/messages" } ?? "/me/messages"
        let page: GraphAPI.Page<GraphMessage> = try await api.get(GraphAPI.path(path, params))
        var ids: [String] = []
        for message in page.value ?? [] where box.isSynced(message.parentFolderId) {
            let has = Set(box.labels(of: message))
            let matches = search.wanted.allSatisfy { wanted in wanted == scope || has.contains(wanted.label) != wanted.negated }
            if matches, !ids.contains(message.thread) { ids.append(message.thread) }
        }
        let have = Set(known.map(\.id))
        return (ids, try await threads(Set(ids).subtracting(have), known: known).threads)
    }

    // ── Changing ─────────────────────────────────────────────────────────────

    func apply(_ change: MailStore.Change, to thread: MailThread, _ state: inout MailboxState) async throws -> MailDelta {
        let box = try await mailbox()
        if case .star(let message) = change {
            try await api.send("PATCH", GraphAPI.messagePath(message), ["flag": ["flagStatus": "flagged"]])
            return MailDelta()
        }
        let messages = try await api.conversations([thread.id])[thread.id] ?? []
        switch change {
        case .modify(let add, let remove):
            try await write(messages, add: add, remove: remove, box)
        case .trash:
            try await write(messages, add: ["TRASH"], remove: [], box)
        case .untrash:
            // Back from Deleted Items: received mail to the inbox, your own to Sent Items.
            let trashed = messages.filter { box.label(ofFolder: $0.parentFolderId) == "TRASH" }
            try await write(trashed, add: [], remove: ["TRASH"], box, wholeThread: false)
        case .delete:
            // PERMANENT, and only what's in Deleted Items or Junk (where it's offered): the rest of the thread stays.
            let doomed = messages.filter { ["TRASH", "SPAM"].contains(box.label(ofFolder: $0.parentFolderId)) }
            try await api.run(doomed.map { GraphAPI.BatchRequest(method: "POST", url: GraphAPI.messagePath($0.id) + "/permanentDelete") })
            return try await reload(thread.id, known: [thread])
        case .star:
            break
        }
        return MailDelta()
    }

    /** A label change as Graph takes it: properties first (a move answers before Graph is done with the message), then moves. */
    private func write(_ messages: [GraphMessage], add: [String], remove: [String], _ box: OutlookFolders, wholeThread: Bool = true) async throws {
        var patches: [GraphAPI.BatchRequest] = []
        var moves: [GraphAPI.BatchRequest] = []
        for message in messages {
            let path = GraphAPI.messagePath(message.id)
            if let patch = OutlookMail.patch(message, add: add, remove: remove) {
                patches.append(.init(method: "PATCH", url: path, body: try JSONSerialization.data(withJSONObject: patch)))
            }
            if let to = OutlookMail.destination(message, add: add, remove: remove, wholeThread: wholeThread, mailbox: email, folders: box) {
                moves.append(.init(method: "POST", url: path + "/move", body: try JSONSerialization.data(withJSONObject: ["destinationId": to])))
            }
        }
        try await api.run(patches)
        try await api.run(moves)
    }

    func refresh(_ thread: MailThread, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        try await reload(thread.id, known: known)
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    func send(_ message: Outgoing, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        let draft = try await self.draft(message, known: known)
        do {
            try await api.send("POST", GraphAPI.messagePath(draft.id) + "/send")
        } catch {
            // Don't leave a half-made draft behind (a draft kept before stays).
            if message.draft == nil { _ = try? await api.send("POST", GraphAPI.messagePath(draft.id) + "/permanentDelete") }
            throw error
        }
        // Outlook sends a moment later; the next sync shows it in Sent.
        return (try? await reload(draft.thread, known: known)) ?? MailDelta()
    }

    func saveDraft(_ message: Outgoing, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        let draft = try await self.draft(message, known: known)
        return (try? await reload(draft.thread, known: known)) ?? MailDelta()
    }

    /**
     * The message as a draft in Outlook: the draft it was, updated in place,
     * else a new one, made with `createReply` on the message it answers so
     * Outlook keeps it in the conversation.
     */
    private func draft(_ message: Outgoing, known: [MailThread]) async throws -> GraphMessage {
        let fields = OutlookMail.fields(message)
        if let id = message.draft {
            do {
                let saved: GraphMessage = try await api.send("PATCH", GraphAPI.messagePath(id), fields)
                try await api.replaceAttachments(message.files, on: saved.id)
                return saved
            } catch let failure as GraphAPI.Failure where failure.notFound {
                // Sent or deleted elsewhere meanwhile: it's made anew.
            }
        }
        let thread = message.threadID.flatMap { id in known.first { $0.id == id } }
        var made: GraphMessage?
        if let replyTo = message.replyTo ?? thread?.sent.last?.id {
            do {
                let reply: GraphMessage = try await api.send("POST", GraphAPI.messagePath(replyTo) + "/createReply")
                made = try await api.send("PATCH", GraphAPI.messagePath(reply.id), fields)
            } catch let failure as GraphAPI.Failure where failure.notFound {
                // The message it answers is gone: a message of its own, then.
            }
        }
        if made == nil { made = try await api.send("POST", "/me/messages", fields) as GraphMessage }
        let draft = made!
        try await api.attach(message.files, to: draft.id)
        return draft
    }

    func deleteDraft(_ messageID: String, _ state: inout MailboxState) async throws {
        do {
            try await api.send("POST", GraphAPI.messagePath(messageID) + "/permanentDelete")
        } catch let failure as GraphAPI.Failure where failure.notFound {}
    }

    /** A file: from the message's MIME source (`mime:<index>`), or Graph's attachment (`graph:<id>`). */
    func attachment(_ attachment: Attachment, of message: Message) async throws -> Data {
        guard let id = attachment.id else { throw GraphAPI.Failure(status: 0, code: "", message: "No file to open.") }
        if id.hasPrefix("graph:") {
            return try await api.data("GET", GraphAPI.messagePath(message.id) + "/attachments/\(GraphAPI.encoded(String(id.dropFirst(6))))/$value")
        }
        guard id.hasPrefix("mime:"), let index = Int(id.dropFirst(5)) else { throw GraphAPI.Failure(status: 0, code: "", message: "No file to open.") }
        let files = try await self.files(of: message.id)
        guard index < files.count else { throw GraphAPI.Failure(status: 404, code: "", message: "The file isn't in Outlook anymore.") }
        return files[index].data
    }

    private func files(of id: String) async throws -> [MIMEParser.File] {
        if let running = sources[id] { return try await running.value }
        if sources.count >= 4 { sources = [:] }
        let task = Task { [api] in try await api.source(id).files }
        sources[id] = task
        do { return try await task.value } catch {
            sources[id] = nil
            throw error
        }
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    /** Graph doesn't expose Outlook's signatures: the mailbox keeps one, following the Otter account (as IMAP's). */
    func signature() async throws -> String? { nil }
    func setSignature(_ html: String) async throws -> String { html }

    // ── Live ─────────────────────────────────────────────────────────────────

    /**
     * Keeps a Graph subscription on the mailbox's messages pointed at the
     * relay, renewed a day before it lapses (they last under three days); the
     * relay's `mail` events then sync. Without one (no relay, or it refused),
     * the mailbox is asked what changed every two minutes while the app is open.
     */
    func watch(pushTopic: String?, _ state: inout MailboxState, onChange: @escaping () -> Void) async -> Task<Void, Never>? {
        if state.subscription != nil, (state.watchExpiresAt ?? .distantPast) > .now.addingTimeInterval(86_400) { return nil }
        do {
            guard let watchTarget else { throw CancellationError() }
            let target = try await watchTarget()
            let expiration = Date.now.addingTimeInterval(70 * 3600)
            var id: String?
            if let current = state.subscription, state.watchTopic == target.notificationUrl {
                do {
                    try await api.send("PATCH", "/subscriptions/\(GraphAPI.encoded(current))", ["expirationDateTime": expiration.formatted(.iso8601)])
                    id = current
                } catch let failure as GraphAPI.Failure where failure.notFound {}
            }
            if id == nil {
                // Graph checks the relay answers before it subscribes (the validation handshake).
                struct Subscription: Decodable { var id: String }
                let made: Subscription = try await api.send("POST", "/subscriptions", [
                    "changeType": "created,updated,deleted",
                    "notificationUrl": target.notificationUrl,
                    "resource": "me/messages",
                    "expirationDateTime": expiration.formatted(.iso8601),
                    "clientState": target.clientState,
                ])
                id = made.id
            }
            state.subscription = id
            state.watchTopic = target.notificationUrl
            state.watchedAt = .now
            state.watchExpiresAt = expiration
            return nil
        } catch {
            return Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(120))
                    if !Task.isCancelled { onChange() }
                }
            }
        }
    }
}
