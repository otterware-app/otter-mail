import Foundation

/**
 * A Gmail mailbox behind `MailProvider`, as core's providers/gmail: history
 * to catch up, labels to change, drafts by Gmail's draft ids, and
 * `users.watch` so Gmail's pushes reach the relay.
 */
final class GmailProvider: MailProvider {
    private let api: GmailAPI

    init(api: GmailAPI) {
        self.api = api
    }

    var capabilities: MailCapabilities { .gmail }
    var takesTurns: Bool { false }

    // ── Reading ──────────────────────────────────────────────────────────────

    func sync(_ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        var delta = MailDelta()
        if let historyID = state.historyID {
            do {
                let (changed, cursor) = try await api.history(since: historyID)
                let fresh = try await api.threads(Array(changed))
                delta = MailDelta(threads: fresh, removed: changed.subtracting(fresh.map(\.id)))
                if !changed.isEmpty { state.draftIDs = try await api.draftIDs() }
                state.historyID = cursor
            } catch is GmailAPI.HistoryExpired {
                state = MailboxState(watchedAt: state.watchedAt, watchExpiresAt: state.watchExpiresAt)
                delta.removed = Set(known.map(\.id))
            }
        }
        if state.historyID == nil {
            // First sync: where Gmail is now, then the inbox's first page.
            state.historyID = try await api.historyID()
            let (ids, next) = try await api.threadIDs(label: "INBOX")
            let page = try await api.threads(ids)
            delta.threads += page
            state.paged(MailSync.key(.inbox), next: next, oldest: page.map(\.latest.date).min())
            state.draftIDs = try await api.draftIDs()
        }
        return delta
    }

    func loadMore(_ folder: Folder, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        let key = MailSync.key(folder)
        let (ids, next) = try await api.threadIDs(label: Self.label(folder), pageToken: state.pages[key])
        let have = Set(known.map(\.id))
        let threads = try await api.threads(ids.filter { !have.contains($0) })
        // How far back the page goes counts the threads already here too.
        let listed = Set(ids)
        let page = threads + known.filter { listed.contains($0.id) }
        state.paged(key, next: next, oldest: page.map(\.latest.date).min())
        return MailDelta(threads: threads)
    }

    func search(_ query: String, known: [MailThread]) async throws -> (ids: [String], threads: [MailThread]) {
        let (ids, _) = try await api.threadIDs(label: nil, query: query, max: 25)
        let have = Set(known.map(\.id))
        return (ids, try await api.threads(ids.filter { !have.contains($0) }))
    }

    func labels() async throws -> [MailLabel] { try await api.labels() }
    func signature() async throws -> String? { try await api.signature() }
    func setSignature(_ html: String) async throws -> String { try await api.setSignature(html) }

    func attachment(_ attachment: Attachment, of message: Message) async throws -> Data {
        guard let id = attachment.id else { throw GmailAPI.Failure(status: 0, message: "No file to open.") }
        return try await api.attachment(message: message.id, id: id)
    }

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

    // ── Changing ─────────────────────────────────────────────────────────────

    func apply(_ change: MailStore.Change, to thread: MailThread, _ state: inout MailboxState) async throws -> MailDelta {
        switch change {
        case .modify(let add, let remove): try await api.modify(thread: thread.id, add: add, remove: remove)
        case .star(let message): try await api.modify(message: message, add: ["STARRED"])
        case .trash: try await api.trash(thread: thread.id)
        case .untrash: try await api.untrash(thread: thread.id)
        case .delete: try await api.delete(thread: thread.id)
        }
        return MailDelta()
    }

    func refresh(_ thread: MailThread, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        try await reload(thread.id)
    }

    private func reload(_ id: String) async throws -> MailDelta {
        if let thread = try await api.thread(id) { MailDelta(threads: [thread]) } else { MailDelta(removed: [id]) }
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    func send(_ message: Outgoing, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        let sent: GmailAPI.Sent
        if let draftID = message.draft.flatMap({ state.draftIDs[$0] }) {
            _ = try await api.saveDraft(id: draftID, raw: message.raw, thread: message.threadID)
            sent = try await api.sendDraft(id: draftID)
        } else {
            sent = try await api.send(raw: message.raw, thread: message.threadID)
        }
        return (try? await reload(sent.threadId)) ?? MailDelta()
    }

    func saveDraft(_ message: Outgoing, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta {
        let draftID = message.draft.flatMap { state.draftIDs[$0] }
        let saved = try await api.saveDraft(id: draftID, raw: message.raw, thread: message.threadID)
        state.draftIDs[saved.message.id] = saved.draft
        return (try? await reload(saved.message.threadId)) ?? MailDelta()
    }

    func deleteDraft(_ messageID: String, _ state: inout MailboxState) async throws {
        guard let draftID = state.draftIDs[messageID] else { return }
        try await api.deleteDraft(id: draftID)
        state.draftIDs[messageID] = nil
    }

    // ── Live ─────────────────────────────────────────────────────────────────

    /** Asks Gmail to push this mailbox's changes to the relay, once a day; the relay's events do the rest. */
    func watch(pushTopic: String?, _ state: inout MailboxState, onChange: @escaping () -> Void) async -> Task<Void, Never>? {
        guard let pushTopic else { return nil }
        guard (state.watchedAt ?? .distantPast) < .now.addingTimeInterval(-86_400)
            || (state.watchExpiresAt ?? .distantPast) < .now.addingTimeInterval(86_400) else { return nil }
        if let watch = try? await api.watch(topic: pushTopic) {
            state.watchedAt = .now
            state.watchExpiresAt = Double(watch.expiration).map { Date(timeIntervalSince1970: $0 / 1000) }
            // watch.historyId is the end marker; never replace a pending history baseline with it.
        }
        return nil
    }
}
