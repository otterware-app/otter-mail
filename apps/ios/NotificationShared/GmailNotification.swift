import Foundation

/** Small direct-Gmail reader: no threads, message bodies, attachments, relay calls, or unbounded history walks. */
nonisolated struct GmailNotification {
    struct Message: Decodable, Sendable {
        struct Payload: Decodable, Sendable {
            struct Header: Decodable, Sendable { var name: String; var value: String }
            var headers: [Header]?
        }
        var id: String
        var threadId: String
        var labelIds: [String]?
        var snippet: String?
        var internalDate: String?
        var payload: Payload?

        func eligible(_ mode: String) -> Bool {
            let labels = Set(labelIds ?? [])
            return mode != "off" && labels.contains("UNREAD") && labels.isDisjoint(with: ["DRAFT", "SENT", "SPAM", "TRASH"])
                && (mode == "all" || labels.contains("INBOX"))
        }
        func header(_ name: String) -> String {
            MailDecoding.words(payload?.headers?.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.value ?? "")
        }

        var sender: String {
            let from = header("From")
            if let bracket = from.firstIndex(of: "<") {
                let name = from[..<bracket].trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                if !name.isEmpty { return name }
            }
            return from
        }
    }
    struct Result: Sendable { var historyId: String; var message: Message?; var count: Int = 0 }
    struct Failure: Error { var status: Int }
    let get: @Sendable (String, [URLQueryItem]) async throws -> Data

    static func direct(email: String) -> Self {
        Self { path, query in
            var components = URLComponents(string: "https://gmail.googleapis.com/gmail/v1/users/me/\(path)")!
            components.queryItems = query
            for attempt in 0..<2 {
                var request = URLRequest(url: components.url!)
                request.timeoutInterval = 8
                let token = try await GoogleCredentials.refresh(email, force: attempt > 0)
                request.setValue("Bearer \(token.accessToken)", forHTTPHeaderField: "Authorization")
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status == 200 { return data }
                if status == 401 && attempt == 0 { continue }
                throw Failure(status: status)
            }
            throw Failure(status: 401)
        }
    }

    /** Returns nil content on rebase: a missing/stale baseline cannot prove which mail just arrived. */
    func enrich(baseline: String?, eventHistoryId: String, mode: String) async throws -> Result {
        guard let baseline else { return try await rebase() }
        guard Self.newer(eventHistoryId, than: baseline) else { return Result(historyId: baseline) }
        struct History: Decodable {
            struct Record: Decodable {
                struct Added: Decodable { struct Ref: Decodable { var id: String }; var message: Ref }
                var messagesAdded: [Added]?
            }
            var history: [Record]?
            var historyId: String
            var nextPageToken: String?
        }
        var pageToken: String?
        var ids: [String] = []
        var seen = Set<String>()
        var cursor = baseline
        var pages = 0
        repeat {
            try Task.checkCancellation()
            var query = [URLQueryItem(name: "startHistoryId", value: baseline), .init(name: "historyTypes", value: "messageAdded"), .init(name: "maxResults", value: "100")]
            if let pageToken { query.append(.init(name: "pageToken", value: pageToken)) }
            let page: History
            do { page = try JSONDecoder().decode(History.self, from: await get("history", query)) }
            catch let error as Failure where error.status == 404 { return try await rebase() }
            for record in page.history ?? [] {
                for added in record.messagesAdded ?? [] where seen.insert(added.message.id).inserted { ids.append(added.message.id) }
            }
            cursor = page.historyId
            pageToken = page.nextPageToken
            pages += 1
            // An incomplete walk never advances the baseline or announces guesses.
            if pageToken != nil && pages >= 5 { throw Failure(status: 0) }
        } while pageToken != nil
        var eligible: [Message] = []
        for id in ids.suffix(8).reversed() {
            try Task.checkCancellation()
            guard id.allSatisfy({ $0.isHexDigit }) else { continue }
            let query = [URLQueryItem(name: "format", value: "metadata"), .init(name: "metadataHeaders", value: "From"), .init(name: "metadataHeaders", value: "Subject"),
                         .init(name: "fields", value: "id,threadId,labelIds,snippet,internalDate,payload/headers")]
            do {
                let message = try JSONDecoder().decode(Message.self, from: await get("messages/\(id)", query))
                if message.eligible(mode) { eligible.append(message) }
            } catch let error as Failure where error.status == 404 {
                // Deleted between history and fetching its metadata.
            }
        }
        try Task.checkCancellation()
        let message = eligible.max { (Int64($0.internalDate ?? "") ?? 0) < (Int64($1.internalDate ?? "") ?? 0) }
        return Result(historyId: cursor, message: message, count: eligible.count)
    }

    private func rebase() async throws -> Result {
        struct Profile: Decodable { var historyId: String }
        let profile = try JSONDecoder().decode(Profile.self, from: await get("profile", [.init(name: "fields", value: "historyId")]))
        return Result(historyId: profile.historyId)
    }

    /** Decimal markers compare without floating point or overflow. */
    static func newer(_ value: String, than baseline: String) -> Bool {
        guard !value.isEmpty, !baseline.isEmpty, value.allSatisfy(\.isNumber), baseline.allSatisfy(\.isNumber) else { return false }
        let a = String(value.drop(while: { $0 == "0" })), b = String(baseline.drop(while: { $0 == "0" }))
        return a.count == b.count ? a > b : a.count > b.count
    }
}

/** Success, expiry, and cancellation race through the same completion gate. */
nonisolated final class NotificationCompletion<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ((Value) -> Void)?
    init(_ handler: @escaping (Value) -> Void) { self.handler = handler }
    func finish(_ value: Value) {
        lock.lock()
        let callback = handler
        handler = nil
        lock.unlock()
        callback?(value)
    }
}
