import Foundation

/**
 * Gmail's REST API for one mailbox, as core's gmail-api.ts uses it: threads
 * to read, history to catch up, labels to change, messages and drafts to
 * send, the signature, attachments, and `watch` for push through the relay.
 */
nonisolated struct GmailAPI {
    let email: String
    /** A fresh access token; `force` skips the cached one (after a 401). */
    let token: @Sendable (_ force: Bool) async throws -> String

    struct Failure: LocalizedError {
        var status: Int
        var message: String
        var errorDescription: String? { message }
        /** The sign-in wasn't granted what the call needs (Gmail settings, for sign-ins from before it was asked for). */
        var insufficientScope: Bool { status == 403 && message.localizedCaseInsensitiveContains("insufficient") }
    }

    /** The history cursor is too old (Gmail keeps about a week): sync from scratch. */
    struct HistoryExpired: Error {}

    // ── Reading ──────────────────────────────────────────────────────────────

    func historyID() async throws -> String {
        struct Profile: Decodable { var historyId: String }
        let profile: Profile = try await get("profile")
        return profile.historyId
    }

    /** The mailbox's own labels, with their colors. */
    func labels() async throws -> [MailLabel] {
        struct Response: Decodable {
            struct Label: Decodable {
                struct Color: Decodable { var backgroundColor: String? }
                var id: String
                var name: String
                var type: String?
                var color: Color?
            }
            var labels: [Label]?
        }
        let response: Response = try await get("labels")
        return (response.labels ?? [])
            .filter { $0.type == "user" }
            .map { MailLabel(id: $0.id, name: $0.name, color: $0.color?.backgroundColor) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /** A page of thread ids, newest first. */
    func threadIDs(label: String?, query: String? = nil, pageToken: String? = nil, max: Int = 30) async throws -> (ids: [String], next: String?) {
        struct Response: Decodable {
            struct Thread: Decodable { var id: String }
            var threads: [Thread]?
            var nextPageToken: String?
        }
        var items = [URLQueryItem(name: "maxResults", value: String(max))]
        if let label { items.append(.init(name: "labelIds", value: label)) }
        if let query { items.append(.init(name: "q", value: query)) }
        if let pageToken { items.append(.init(name: "pageToken", value: pageToken)) }
        if label == "SPAM" || label == "TRASH" { items.append(.init(name: "includeSpamTrash", value: "true")) }
        let response: Response = try await get("threads", query: items)
        return ((response.threads ?? []).map(\.id), response.nextPageToken)
    }

    /** A whole thread; decode JSON, MIME and HTML off the caller's actor. Nil when it's gone. */
    @concurrent
    func thread(_ id: String) async throws -> MailThread? {
        do {
            let thread: GmailThread = try await get("threads/\(id)", query: [.init(name: "format", value: "full")])
            return thread.mailThread(mailbox: email)
        } catch let failure as Failure where failure.status == 404 {
            return nil
        }
    }

    /** Threads, fetched a few at a time; the missing are left out. */
    func threads(_ ids: [String]) async throws -> [MailThread] {
        try await withThrowingTaskGroup(of: (Int, MailThread?).self) { group in
            var results: [(Int, MailThread?)] = []
            for (index, id) in ids.enumerated() {
                if index >= 8, let done = try await group.next() { results.append(done) }
                group.addTask { (index, try await thread(id)) }
            }
            for try await done in group { results.append(done) }
            return results.sorted { $0.0 < $1.0 }.compactMap(\.1)
        }
    }

    /** Threads that changed since `historyID`, and the new cursor. */
    func history(since historyID: String) async throws -> (changed: Set<String>, cursor: String) {
        struct Response: Decodable {
            struct Record: Decodable {
                struct Change: Decodable {
                    struct Ref: Decodable { var threadId: String }
                    var message: Ref
                }
                var messagesAdded, messagesDeleted, labelsAdded, labelsRemoved: [Change]?
            }
            var history: [Record]?
            var historyId: String
            var nextPageToken: String?
        }
        var changed = Set<String>()
        var pageToken: String?
        var cursor = historyID
        repeat {
            var items = [URLQueryItem(name: "startHistoryId", value: historyID), .init(name: "maxResults", value: "500")]
            if let pageToken { items.append(.init(name: "pageToken", value: pageToken)) }
            let response: Response
            do {
                response = try await get("history", query: items)
            } catch let failure as Failure where failure.status == 404 {
                throw HistoryExpired()
            }
            for record in response.history ?? [] {
                for change in [record.messagesAdded, record.messagesDeleted, record.labelsAdded, record.labelsRemoved].compactMap({ $0 }).joined() {
                    changed.insert(change.message.threadId)
                }
            }
            cursor = response.historyId
            pageToken = response.nextPageToken
        } while pageToken != nil
        return (changed, cursor)
    }

    /** Draft message ids → their draft ids (sending or deleting a draft needs the latter). */
    func draftIDs() async throws -> [String: String] {
        struct Response: Decodable {
            struct Draft: Decodable {
                struct Ref: Decodable { var id: String }
                var id: String
                var message: Ref
            }
            var drafts: [Draft]?
        }
        let response: Response = try await get("drafts", query: [.init(name: "maxResults", value: "500")])
        return Dictionary((response.drafts ?? []).map { ($0.message.id, $0.id) }) { a, _ in a }
    }

    @concurrent
    func attachment(message: String, id: String) async throws -> Data {
        struct Response: Decodable { var data: String }
        let response: Response = try await get("messages/\(message)/attachments/\(id)")
        return Data(base64URL: response.data) ?? Data()
    }

    // ── Changing ─────────────────────────────────────────────────────────────

    func modify(thread: String, add: [String] = [], remove: [String] = []) async throws {
        try await post("threads/\(thread)/modify", ["addLabelIds": add, "removeLabelIds": remove])
    }

    func modify(message: String, add: [String] = [], remove: [String] = []) async throws {
        try await post("messages/\(message)/modify", ["addLabelIds": add, "removeLabelIds": remove])
    }

    func trash(thread: String) async throws { try await post("threads/\(thread)/trash", [String: String]()) }
    func untrash(thread: String) async throws { try await post("threads/\(thread)/untrash", [String: String]()) }
    func delete(thread: String) async throws { _ = try await request("DELETE", "threads/\(thread)") }

    // ── Writing ──────────────────────────────────────────────────────────────

    struct Sent: Decodable {
        var id: String
        var threadId: String
    }

    func send(raw: Data, thread: String?) async throws -> Sent {
        try await decode(post("messages/send", Raw(raw: raw.base64URL, threadId: thread)))
    }

    /** Creates or replaces a draft; answers its draft id and message. */
    func saveDraft(id: String?, raw: Data, thread: String?) async throws -> (draft: String, message: Sent) {
        struct Response: Decodable { var id: String; var message: Sent }
        let body = ["message": Raw(raw: raw.base64URL, threadId: thread)]
        let data = if let id {
            try await request("PUT", "drafts/\(id)", body: try JSONEncoder().encode(body))
        } else {
            try await post("drafts", body)
        }
        let response: Response = try decode(data)
        return (response.id, response.message)
    }

    func sendDraft(id: String) async throws -> Sent {
        try await decode(post("drafts/send", ["id": id]))
    }

    func deleteDraft(id: String) async throws { _ = try await request("DELETE", "drafts/\(id)") }

    // ── Settings ─────────────────────────────────────────────────────────────

    /** The address's signature in Gmail (Settings › Signature on the web), as HTML. */
    func signature() async throws -> String {
        struct Response: Decodable {
            struct SendAs: Decodable { var sendAsEmail: String; var isPrimary: Bool?; var signature: String? }
            var sendAs: [SendAs]?
        }
        let response: Response = try await get("settings/sendAs")
        let all = response.sendAs ?? []
        let own = all.first { $0.sendAsEmail.lowercased() == email.lowercased() } ?? all.first { $0.isPrimary == true }
        return own?.signature ?? ""
    }

    /** Saves the signature in Gmail; answers it as Gmail stored it (sanitized). */
    func setSignature(_ html: String) async throws -> String {
        struct Response: Decodable { var signature: String? }
        let data = try await request("PATCH", "settings/sendAs/\(email)", body: try JSONEncoder().encode(["signature": html]))
        return (try decode(data) as Response).signature ?? ""
    }

    /** Asks Gmail to publish the mailbox's changes to the relay's topic (renew daily; it lapses after a week). */
    struct Watch: Decodable { var historyId: String; var expiration: String }

    func watch(topic: String) async throws -> Watch {
        try decode(try await post("watch", ["topicName": topic]))
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private struct Raw: Encodable {
        var raw: String
        var threadId: String?
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try decode(try await request("GET", path, query: query))
    }

    @discardableResult
    private func post(_ path: String, _ body: some Encodable) async throws -> Data {
        try await request("POST", path, body: try JSONEncoder().encode(body))
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        try JSONDecoder().decode(T.self, from: data)
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        var components = URLComponents(string: "https://gmail.googleapis.com/gmail/v1/users/me/\(path)")!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        for attempt in 0..<3 {
            request.setValue("Bearer \(try await token(attempt > 0))", forHTTPHeaderField: "Authorization")
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) { return data }
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { ($0["error"] as? [String: Any])?["message"] as? String }
            let rateLimited = status == 429 || (status == 403 && message?.localizedCaseInsensitiveContains("rate") == true)
            if attempt < 2, status == 401 || rateLimited || status >= 500 {
                if status != 401 { try await Task.sleep(for: .seconds(attempt + 1)) }
                continue
            }
            throw Failure(status: status, message: message ?? "Gmail answered \(status).")
        }
        throw Failure(status: 0, message: "Gmail didn't answer.")
    }
}

// ── Gmail's thread resource, into the app's model ─────────────────────────

nonisolated private struct GmailThread: Decodable {
    var id: String
    var messages: [GmailMessage]?

    func mailThread(mailbox: String) -> MailThread? {
        let messages = (self.messages ?? []).map { $0.message() }
        guard let first = self.messages?.first, !messages.isEmpty else { return nil }
        var labels = Set(self.messages!.flatMap { $0.labelIds ?? [] })
        labels.subtract(["UNREAD", "STARRED", "DRAFT"])
        return MailThread(
            id: id,
            mailbox: mailbox,
            subject: first.payload?.header("Subject") ?? "(no subject)",
            labels: labels,
            messages: messages
        )
    }
}

nonisolated private struct GmailMessage: Decodable {
    var id: String
    var labelIds: [String]?
    var internalDate: String?
    var payload: Part?

    struct Part: Decodable {
        struct Header: Decodable { var name: String; var value: String }
        struct Body: Decodable { var data: String?; var size: Int?; var attachmentId: String? }
        var mimeType: String?
        var filename: String?
        var headers: [Header]?
        var body: Body?
        var parts: [Part]?

        func header(_ name: String) -> String? {
            headers?.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.value
        }

        /** Every leaf part, depth first. */
        var leaves: [Part] { parts.map { $0.flatMap(\.leaves) } ?? [self] }

        var text: String? {
            guard let data = body?.data, let bytes = Data(base64URL: data) else { return nil }
            return String(data: bytes, encoding: .utf8) ?? String(data: bytes, encoding: .isoLatin1)
        }
    }

    func message() -> Message {
        let payload = payload ?? Part()
        let leaves = payload.leaves
        let isFile = { (part: Part) in !(part.filename ?? "").isEmpty }
        let html = leaves.first { $0.mimeType == "text/html" && !isFile($0) }?.text
        let text = leaves.first { $0.mimeType == "text/plain" && !isFile($0) }?.text
            ?? html.map(HTMLText.plain) ?? ""
        // Inline images (a Content-ID, not marked as an attachment) are part of the body.
        let isInline = { (part: Part) in
            part.header("Content-ID") != nil
                && part.header("Content-Disposition")?.lowercased().hasPrefix("attachment") != true
        }
        let attachments = leaves.filter { isFile($0) && $0.body?.attachmentId != nil && !isInline($0) }
            .map { Attachment(id: $0.body?.attachmentId, filename: $0.filename ?? "", mimeType: $0.mimeType ?? "", size: $0.body?.size ?? 0) }
        let inline = leaves.filter { $0.body?.attachmentId != nil && isInline($0) }
            .map { part in
                Attachment(
                    id: part.body?.attachmentId, filename: part.filename ?? "", mimeType: part.mimeType ?? "",
                    size: part.body?.size ?? 0,
                    contentID: part.header("Content-ID")?.trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
                )
            }
        let labels = Set(labelIds ?? [])
        var headers: [String: String] = [:]
        for name in ["Message-ID", "References", "List-Unsubscribe", "List-Unsubscribe-Post", "Bcc"] {
            if let value = payload.header(name) { headers[name] = value }
        }
        return Message(
            id: id,
            from: Addresses.parse(payload.header("From") ?? "").first ?? Person(name: "", email: ""),
            to: Addresses.parse(payload.header("To") ?? ""),
            cc: Addresses.parse(payload.header("Cc") ?? ""),
            date: Date(timeIntervalSince1970: (Double(internalDate ?? "") ?? 0) / 1000),
            text: text,
            html: html,
            attachments: attachments,
            inline: inline.isEmpty ? nil : inline,
            unread: labels.contains("UNREAD"),
            starred: labels.contains("STARRED"),
            draft: labels.contains("DRAFT"),
            headers: headers
        )
    }
}

/** Address headers: `"Last, First" <a@b.c>, d@e.f`, with quoted commas kept. */
nonisolated enum Addresses {
    static func parse(_ header: String) -> [Person] {
        var entries: [String] = []
        var current = ""
        var quoted = false
        var angle = false
        for character in header {
            switch character {
            case "\"": quoted.toggle()
            case "<" where !quoted: angle = true
            case ">" where !quoted: angle = false
            case "," where !quoted && !angle:
                entries.append(current)
                current = ""
                continue
            default: break
            }
            current.append(character)
        }
        entries.append(current)
        return entries.compactMap { entry in
            let entry = entry.trimmingCharacters(in: .whitespaces)
            if let open = entry.lastIndex(of: "<"), let close = entry.lastIndex(of: ">"), open < close {
                let email = String(entry[entry.index(after: open)..<close]).trimmingCharacters(in: .whitespaces)
                let name = entry[..<open].trimmingCharacters(in: .whitespaces.union(["\""]))
                return email.contains("@") ? Person(name: name, email: email) : nil
            }
            return entry.contains("@") ? Person(name: "", email: entry) : nil
        }
    }
}

/** HTML's readable text, for messages sent without a plain-text part. */
nonisolated enum HTMLText {
    static func plain(_ html: String) -> String {
        var text = html
        for (pattern, replacement) in [
            ("(?is)<(style|script|head)[^>]*>.*?</\\1>", ""),
            ("(?i)<br\\s*/?>", "\n"),
            ("(?i)</(div|p|li|tr|h[1-6]|table)>", "\n"),
            ("<[^>]+>", ""),
            ("[ \\t]+", " "),
            ("\\n\\s*\\n+", "\n\n"),
        ] {
            text = text.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        for (entity, character) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&rsquo;", "’"), ("&mdash;", "—"), ("&amp;", "&")] {
            text = text.replacingOccurrences(of: entity, with: character)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
