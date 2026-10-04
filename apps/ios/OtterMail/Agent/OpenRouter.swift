import Foundation

/** A client of the relay's AI SDK agent. The OpenRouter key and model loop stay on the server. */
@MainActor
struct OpenRouter {
    let baseURL: URL
    let token: String

    init(relay: Relay) throws {
        guard let token = relay.token else {
            throw Hermes.Failure(message: "Sign in to your Otter account to use OpenRouter.")
        }
        self.baseURL = relay.baseURL
        self.token = token
    }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> URLRequest {
        var request = URLRequest(url: URL(string: "/v1/agent\(path)", relativeTo: baseURL)!)
        request.httpMethod = method
        request.timeoutInterval = path == "/turn" ? 900 : 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func send(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Any {
        let (data, response) = try await URLSession.shared.data(for: request(method, path, body: body))
        let value = try JSONSerialization.jsonObject(with: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Hermes.Failure(message: (value as? [String: Any])?["error"] as? String ?? "The agent server could not complete this request.")
        }
        return value
    }

    func connection(key: String? = nil) async throws -> (connected: Bool, models: [Hermes.Model]) {
        let response = try await send(key == nil ? "GET" : "PUT", "/connection", body: key.map { ["apiKey": $0] })
        let value = (response as? [String: Any]) ?? [:]
        let models = (value["models"] as? [[String: Any]] ?? []).compactMap { row -> Hermes.Model? in
            guard let slug = row["slug"] as? String else { return nil }
            return Hermes.Model(slug: slug, name: (row["name"] as? String) ?? slug, subProvider: row["subProvider"] as? String,
                                isDefault: (row["isDefault"] as? Bool) ?? false, reasoning: false, canDisableReasoning: false, fast: false)
        }
        return ((value["connected"] as? Bool) ?? false, models)
    }

    func disconnect() async throws { _ = try await send("DELETE", "/connection") }
    func stop(_ requestID: String) async { _ = try? await send("POST", "/cancel", body: ["requestId": requestID]) }

    func sessions() async throws -> [Hermes.Session] {
        let rows = try await send("GET", "/sessions") as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let id = row["id"] as? String else { return nil }
            return Hermes.Session(id: id, title: row["title"] as? String, preview: row["preview"] as? String,
                                  lastActive: Date(timeIntervalSince1970: ((row["lastActive"] as? Double) ?? 0) / 1000),
                                  messageCount: (row["messageCount"] as? Int) ?? 0)
        }
    }

    func messages(of id: String) async throws -> [Hermes.Message] {
        let rows = try await send("GET", "/sessions/\(id)") as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let role = row["role"] as? String else { return nil }
            let tools = (row["toolCalls"] as? [[String: Any]] ?? []).compactMap { $0["title"] as? String }
            return Hermes.Message(role: role, text: (row["text"] as? String) ?? "", tools: tools)
        }
    }

    func delete(session: String) async throws { _ = try await send("DELETE", "/sessions/\(session)") }

    /** Streams server events; only tool execution and its permissions happen on this iPhone. */
    func turn(_ body: [String: Any], event: @MainActor ([String: Any]) async throws -> Void,
              tool: @MainActor (String, [String: Any]) async -> [String: Any]) async throws {
        let (bytes, response) = try await URLSession.shared.bytes(for: request("POST", "/turn", body: body))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true else {
            throw Hermes.Failure(message: "Can't reach the agent server. Check your Otter account connection.")
        }
        var terminal = false
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.hasPrefix("data: "), let data = line.dropFirst(6).data(using: .utf8),
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  value["requestId"] as? String == body["requestId"] as? String else { continue }
            if value["type"] as? String == "toolRequest" {
                guard let id = value["id"] as? String, let name = value["name"] as? String,
                      let input = value["input"] as? [String: Any] else { throw Hermes.Failure(message: "Invalid tool request.") }
                let output = await tool(name, input)
                try Task.checkCancellation()
                _ = try await send("POST", "/tool-result", body: ["requestId": body["requestId"]!, "id": id, "output": output])
            } else {
                if ["done", "error"].contains((value["type"] as? String) ?? "") { terminal = true }
                try await event(value)
            }
        }
        if !terminal { throw Hermes.Failure(message: "The connection ended before the agent finished. Try again.") }
    }
}
