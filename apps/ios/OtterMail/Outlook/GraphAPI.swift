import Foundation

/**
 * Microsoft Graph for one Outlook mailbox, as core's outlook/graph.ts uses it.
 *
 * Every request asks for immutable ids (`Prefer: IdType="ImmutableId"`), so a
 * message keeps its id when it moves between folders, as a Gmail message does
 * when its labels change. Graph allows 4 requests in flight per mailbox and
 * answers 429 with Retry-After past its limits: requests take turns at the
 * mailbox's gate, and a 429 holds every request back for as long as it says.
 */
nonisolated struct GraphAPI {
    let email: String
    /** A fresh access token; `force` skips the cached one (after a 401). */
    let token: @Sendable (_ force: Bool) async throws -> String
    /** Where requests go (tests answer them). */
    var transport: @Sendable (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }
    let gate = GraphGate()

    static let root = "https://graph.microsoft.com/v1.0"

    struct Failure: LocalizedError {
        var status: Int
        /** Graph's own code ("ErrorItemNotFound", "syncStateNotFound", …). */
        var code: String
        var message: String
        var errorDescription: String? { message.isEmpty ? "Outlook answered \(status)." : message }
        var notFound: Bool { status == 404 || code == "ErrorItemNotFound" }
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    /** `path` (under the API root) with its query, each value percent-encoded. */
    static func path(_ path: String, _ query: [(String, String)] = []) -> String {
        guard !query.isEmpty else { return path }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~,'()$:/@*")
        return path + "?" + query.map { "\($0)=\($1.addingPercentEncoding(withAllowedCharacters: allowed) ?? $1)" }.joined(separator: "&")
    }

    /** A request's answer: retried after a 401 (a fresh token), a 429 or 503 (Graph's wait), or a 5xx. */
    func data(_ method: String = "GET", _ path: String, body: Data? = nil, contentType: String = "application/json", prefer: [String] = []) async throws -> Data {
        guard let url = URL(string: path.hasPrefix("https://") ? path : Self.root + path) else {
            throw Failure(status: 0, code: "", message: "Couldn't make a request to Outlook.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 60
        request.setValue((["IdType=\"ImmutableId\""] + prefer).joined(separator: ", "), forHTTPHeaderField: "Prefer")
        if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        } else if method != "GET" {
            // Graph wants a length on every POST (`/send`, `/move` …), even an empty one.
            request.httpBody = Data()
        }
        var refreshed = false, force = false
        for attempt in 0..<5 {
            request.setValue("Bearer \(try await token(force))", forHTTPHeaderField: "Authorization")
            force = false
            await gate.enter()
            let answer: (Data, URLResponse)
            do {
                answer = try await transport(request)
            } catch {
                await gate.leave()
                throw error
            }
            await gate.leave()
            let (data, response) = answer
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            if (200..<300).contains(status) { return data }
            if status == 401, !refreshed {
                (refreshed, force) = (true, true)
                continue
            }
            if (status == 429 || status == 503), attempt < 4 {
                let wait = http?.value(forHTTPHeaderField: "Retry-After").flatMap { Double($0) } ?? Double(1 << attempt)
                await gate.coolDown(for: wait)
                continue
            }
            if status >= 500, attempt < 2 {
                try await Task.sleep(for: .seconds(attempt + 1))
                continue
            }
            throw Self.failure(status, data)
        }
        throw Failure(status: 429, code: "", message: "Outlook is limiting requests right now. Try again shortly.")
    }

    func get<T: Decodable>(_ path: String, prefer: [String] = []) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await data("GET", path, prefer: prefer))
    }

    /** A JSON request's answer (`{}` for an empty one). */
    @discardableResult
    func send(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> Data {
        let answer = try await data(method, path, body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
        return answer.isEmpty ? Data("{}".utf8) : answer
    }

    func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await send(method, path, body))
    }

    static func failure(_ status: Int, _ data: Data) -> Failure {
        let error = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any]
        return Failure(status: status, code: error?["code"] as? String ?? "", message: (error?["message"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // ── Batches ──────────────────────────────────────────────────────────────

    struct BatchRequest {
        var method = "GET"
        /** Relative to the API root: `/me/messages/…`. */
        var url: String
        /** JSON. */
        var body: Data? = nil
    }

    struct BatchResponse {
        var status: Int
        /** The answer's body, as JSON. */
        var body: Data
        var ok: Bool { (200..<300).contains(status) }
    }

    /**
     * Runs requests in `$batch`es of 20 (Graph's most), in order, answering
     * each one's status and body. Throttled ones are asked again after Graph's
     * Retry-After; other failures are answered for the caller to judge.
     */
    func batch(_ requests: [BatchRequest]) async throws -> [BatchResponse] {
        var results = [BatchResponse?](repeating: nil, count: requests.count)
        for start in stride(from: 0, to: requests.count, by: 20) {
            var pending = Array(start..<min(start + 20, requests.count))
            var round = 0
            while !pending.isEmpty {
                let payload: [String: Any] = ["requests": try pending.map { index in
                    let request = requests[index]
                    var entry: [String: Any] = ["id": String(index), "method": request.method, "url": request.url]
                    var headers = ["Prefer": "IdType=\"ImmutableId\""]
                    if let body = request.body {
                        entry["body"] = try JSONSerialization.jsonObject(with: body)
                        headers["Content-Type"] = "application/json"
                    }
                    entry["headers"] = headers
                    return entry
                }]
                let answer = try await send("POST", "/$batch", payload)
                let responses = (try JSONSerialization.jsonObject(with: answer) as? [String: Any])?["responses"] as? [[String: Any]] ?? []
                var throttled: [Int] = []
                var wait = 0.0
                for response in responses {
                    guard let index = (response["id"] as? String).flatMap(Int.init), index < requests.count else { continue }
                    let status = response["status"] as? Int ?? 0
                    if status == 429, round < 5 {
                        throttled.append(index)
                        let headers = response["headers"] as? [String: String] ?? [:]
                        wait = max(wait, headers.first { $0.key.lowercased() == "retry-after" }.flatMap { Double($0.value) } ?? 2)
                        continue
                    }
                    let body = response["body"].flatMap { body in
                        JSONSerialization.isValidJSONObject(body) ? (try? JSONSerialization.data(withJSONObject: body)) : nil
                    }
                    results[index] = BatchResponse(status: status, body: body ?? Data("{}".utf8))
                }
                pending = throttled
                round += 1
                if !pending.isEmpty { await gate.coolDown(for: wait) }
            }
        }
        return results.map { $0 ?? BatchResponse(status: 0, body: Data("{}".utf8)) }
    }
}

// ── Mail ─────────────────────────────────────────────────────────────────────

nonisolated extension GraphAPI {
    /** One page of a collection, and the link to the next page or (a delta's last) the next round. */
    struct Page<T: Decodable>: Decodable {
        var value: [T]?
        var nextLink: String?
        var deltaLink: String?

        enum CodingKeys: String, CodingKey {
            case value
            case nextLink = "@odata.nextLink"
            case deltaLink = "@odata.deltaLink"
        }
    }

    /** A message's resource path (immutable ids carry "=" and the like). */
    static func messagePath(_ id: String) -> String { "/me/messages/\(encoded(id))" }
    static func folderPath(_ id: String) -> String { "/me/mailFolders/\(encoded(id))" }

    static func encoded(_ id: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.")
        return id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
    }

    /** Every item of a collection, following its pages. */
    func all<T: Decodable>(_ path: String) async throws -> [T] {
        var items: [T] = []
        var next: String? = path
        while let url = next {
            let page: Page<T> = try await get(url)
            items += page.value ?? []
            next = page.nextLink
        }
        return items
    }

    // ── Folders ──────────────────────────────────────────────────────────────

    /** The folder tree and categories (a few requests); the well-known folders' ids are asked for once. */
    func folders(wellKnown known: [String: String]?) async throws -> OutlookFolders {
        var wellKnown = known ?? [:]
        if wellKnown["inbox"] == nil {
            struct Ref: Decodable { var id: String }
            let names = OutlookFolders.wellKnownNames
            let answers = try await batch(names.map { BatchRequest(url: "/me/mailFolders/\($0)?$select=id") })
            for (name, answer) in zip(names, answers) where answer.ok {
                if let ref = try? JSONDecoder().decode(Ref.self, from: answer.body) { wellKnown[name] = ref.id }
            }
            guard wellKnown["inbox"] != nil else { throw Failure(status: 0, code: "", message: "Outlook didn't say where this mailbox's inbox is.") }
        }
        var children: [String?: [OutlookFolders.ApiFolder]] = [:]
        var parents: [String?] = [nil]
        while let parent = parents.popLast() {
            let path = parent.map { Self.folderPath($0) + "/childFolders" } ?? "/me/mailFolders"
            let list: [OutlookFolders.ApiFolder] = try await all(Self.path(path, [("$top", "100"), ("$select", "id,displayName,childFolderCount")]))
            children[parent] = list
            parents += list.filter { ($0.childFolderCount ?? 0) > 0 }.map(\.id)
        }
        struct Category: Decodable { var displayName: String; var color: String? }
        // Some mailboxes won't say: no categories, then.
        let categories = (try? await get("/me/outlook/masterCategories") as Page<Category>)?.value ?? []
        return OutlookFolders(wellKnown: wellKnown, children: children, categories: categories.map { .init(name: $0.displayName, color: $0.color ?? "none") })
    }

    // ── Messages ─────────────────────────────────────────────────────────────

    /** Conversations' messages, by conversation id (20 conversations to a request); a gone one has none. */
    func conversations(_ ids: [String]) async throws -> [String: [GraphMessage]] {
        let requests = ids.map { id in
            BatchRequest(url: Self.path("/me/messages", [
                ("$filter", "conversationId eq '\(id.replacingOccurrences(of: "'", with: "''"))'"),
                ("$select", GraphMessage.fields),
                ("$top", "100"),
            ]))
        }
        var found: [String: [GraphMessage]] = [:]
        for (id, answer) in zip(ids, try await batch(requests)) {
            if answer.ok {
                found[id] = try JSONDecoder().decode(Page<GraphMessage>.self, from: answer.body).value ?? []
            } else if answer.status == 404 {
                found[id] = []
            } else {
                throw Self.failure(answer.status, answer.body)
            }
        }
        return found
    }

    /** Words, files and headers of messages, 4 at a time (Graph's most); a message gone meanwhile is left out. */
    func contents(_ messages: [GraphMessage]) async throws -> [String: OutlookContent] {
        try await withThrowingTaskGroup(of: (String, OutlookContent?).self) { group in
            var contents: [String: OutlookContent] = [:]
            for (index, message) in messages.enumerated() {
                if index >= 4, let done = try await group.next() { contents[done.0] = done.1 }
                group.addTask {
                    do {
                        let found = try await content(message)
                        return (message.id, found)
                    } catch let failure as Failure where failure.notFound {
                        return (message.id, nil)
                    }
                }
            }
            for try await (id, content) in group { contents[id] = content }
            return contents
        }
    }

    /**
     * A message's words, files and headers, from its MIME source. One whose
     * attachments pass 2 MB is read from Graph's properties instead, so they
     * aren't downloaded until opened.
     */
    func content(_ message: GraphMessage) async throws -> OutlookContent {
        let path = Self.messagePath(message.id)
        if message.hasAttachments == true {
            let files: [GraphAttachment] = try await all(Self.path(path + "/attachments", [("$select", "id,name,contentType,size,isInline")]))
            if files.reduce(0, { $0 + ($1.size ?? 0) }) > 2_000_000 {
                let full: GraphMessage = try await get(
                    Self.path(path, [("$select", "body,internetMessageId,internetMessageHeaders")]),
                    prefer: ["outlook.body-content-type=\"html\""]
                )
                return OutlookMail.content(full, attachments: files)
            }
        }
        return OutlookMail.content(try await source(message.id))
    }

    /** The message's MIME source, parsed off the main actor. */
    func source(_ id: String) async throws -> MIMEParser.Parsed {
        await Self.parse(try await data("GET", Self.messagePath(id) + "/$value"))
    }

    @concurrent
    private static func parse(_ source: Data) async -> MIMEParser.Parsed { MIMEParser.parse(source) }

    // ── Delta ────────────────────────────────────────────────────────────────

    /** What a folder's delta said: messages added or changed, messages gone, and the link for the next round. */
    struct Delta {
        var changed: [GraphMessage] = []
        var removed: [String] = []
        var link: String
    }

    /** Where following a folder's changes starts: its mail since `since` (a first round lists it, then come changes). */
    static func deltaStart(_ folder: String, since: Date) -> String {
        path(folderPath(folder) + "/messages/delta", [
            ("$select", "id,conversationId,receivedDateTime"),
            ("$filter", "receivedDateTime ge \(since.formatted(.iso8601))"),
        ])
    }

    /** Follows a delta link to its round's end. */
    func delta(_ link: String) async throws -> Delta {
        var delta = Delta(link: link)
        var next: String? = link
        while let url = next {
            let page: Page<GraphMessage> = try await get(url, prefer: ["odata.maxpagesize=100"])
            for message in page.value ?? [] {
                if message.removed != nil { delta.removed.append(message.id) } else { delta.changed.append(message) }
            }
            next = page.nextLink
            if let link = page.deltaLink { delta.link = link }
        }
        return delta
    }

    /** Graph lost track of a delta (it expired): the folder starts over. */
    static func expired(_ error: Error) -> Bool {
        guard let failure = error as? Failure else { return false }
        return failure.status == 410 || failure.code.localizedCaseInsensitiveContains("syncState")
            || failure.code.localizedCaseInsensitiveContains("resync")
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /** Batched writes; a message already gone (404) is fine, any other failure isn't. */
    func run(_ requests: [BatchRequest]) async throws {
        for answer in try await batch(requests) where !answer.ok && answer.status != 404 {
            throw Self.failure(answer.status, answer.body)
        }
    }

    /** Puts files on a draft: small ones in one request, those past 3 MB in an upload session's chunks. */
    func attach(_ files: [MIME.File], to draft: String) async throws {
        let path = Self.messagePath(draft) + "/attachments"
        for file in files {
            if file.data.count <= 3 * 1024 * 1024 {
                try await send("POST", path, [
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": file.filename,
                    "contentType": file.mimeType,
                    "contentBytes": file.data.base64EncodedString(),
                ])
                continue
            }
            struct Upload: Decodable { var uploadUrl: String }
            let upload: Upload = try await send("POST", path + "/createUploadSession", [
                "AttachmentItem": ["attachmentType": "file", "name": file.filename, "size": file.data.count, "contentType": file.mimeType] as [String: Any],
            ])
            guard let url = URL(string: upload.uploadUrl) else { throw Failure(status: 0, code: "", message: "Outlook didn't take \(file.filename).") }
            // Chunks in multiples of 320 KiB; the upload URL carries its own authorization.
            let chunk = 10 * 320 * 1024
            for start in stride(from: 0, to: file.data.count, by: chunk) {
                let end = min(start + chunk, file.data.count)
                var request = URLRequest(url: url)
                request.httpMethod = "PUT"
                request.httpBody = file.data.subdata(in: start..<end)
                request.setValue("bytes \(start)-\(end - 1)/\(file.data.count)", forHTTPHeaderField: "Content-Range")
                let (_, response) = try await transport(request)
                guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
                    throw Failure(status: 0, code: "", message: "Couldn't upload \(file.filename) to Outlook.")
                }
            }
        }
    }

    /** Makes a draft's files the composer's: drops those it no longer has, adds the new ones (matched by name). */
    func replaceAttachments(_ files: [MIME.File], on draft: String) async throws {
        let path = Self.messagePath(draft) + "/attachments"
        let existing: [GraphAttachment] = try await all(Self.path(path, [("$select", "id,name,isInline")]))
        var wanted = files
        for current in existing where current.isInline != true {
            if let at = wanted.firstIndex(where: { $0.filename == current.name }) {
                wanted.remove(at: at)
            } else {
                try await send("DELETE", "\(path)/\(Self.encoded(current.id))")
            }
        }
        try await attach(wanted, to: draft)
    }
}

/**
 * A mailbox's turns at Graph: 4 requests in flight at most, the rest waiting
 * in order; after a 429, nobody goes until Graph's wait is over.
 */
actor GraphGate {
    private var inFlight = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var until = Date.distantPast

    func enter() async {
        while until > .now { try? await Task.sleep(for: .seconds(until.timeIntervalSinceNow)) }
        // A waiting request is handed the slot of the one that leaves.
        if inFlight >= 4 { await withCheckedContinuation { waiting.append($0) } } else { inFlight += 1 }
    }

    func leave() {
        if waiting.isEmpty { inFlight -= 1 } else { waiting.removeFirst().resume() }
    }

    /** Holds every request back `seconds` (at most a minute: Graph's waits are short). */
    func coolDown(for seconds: Double) async {
        until = max(until, .now.addingTimeInterval(min(max(seconds, 1), 60)))
        while until > .now { try? await Task.sleep(for: .seconds(until.timeIntervalSinceNow)) }
    }
}
