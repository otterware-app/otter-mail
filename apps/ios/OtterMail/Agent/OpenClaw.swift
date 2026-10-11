import CryptoKit
import Foundation

/**
 * OpenClaw over its gateway's WebSocket, as the Mac connects (core's
 * openclaw.ts) and OpenClaw's own apps do. This iPhone is a device with its
 * own Ed25519 key: a setup code from `openclaw qr` (or the gateway token)
 * introduces it once, the user approves it on the gateway (`openclaw devices
 * approve`), and from then on it signs in with the device token the gateway
 * issued. The key and tokens stay on this iPhone.
 *
 * A run belongs to the gateway, not the app: it goes on when the app goes to
 * the background. It's sent with the turn's id as its idempotency key, which
 * the gateway keeps on the user's transcript row, so the run is found again
 * by it, shown as far as it got, and followed if it's still going.
 */
final class OpenClaw {
    nonisolated struct Failure: LocalizedError {
        /** The gateway's reason: `PAIRING_REQUIRED`, `AUTH_TOKEN_MISMATCH`, … */
        var code: String?
        var message: String
        /** The pairing request a `PAIRING_REQUIRED` refusal names. */
        var requestID: String?
        var errorDescription: String? { message }
    }

    /** Where the key and tokens are kept (the Keychain). */
    struct Secrets {
        var get: (String) -> String?
        var set: (String, String?) -> Void
    }

    /** One of the gateway's agents, the models to pick. */
    nonisolated struct GatewayAgent: Equatable {
        var id: String
        var name: String
        var isDefault: Bool
    }

    nonisolated struct Chat: Equatable {
        var id: String
        var title: String?
        var preview: String?
        var lastActive: Date
    }

    /** A transcript row, flattened: what the agent said, and the tools it called (with their results). */
    nonisolated struct Message: Equatable {
        var role: String
        var text: String
        var steps: [Step] = []
    }

    nonisolated struct Step: Equatable {
        var id: String?
        var name: String
        var output: String?
    }

    /** A run's reply as far as it got. */
    nonisolated struct Reply: Equatable {
        var text = ""
        var steps: [Step] = []
    }

    nonisolated struct Approval: Equatable {
        var id: String
        var command: String?
    }

    /** What a followed run reports. */
    nonisolated enum Event {
        case reply(Reply)
        case approval(Approval)
        case approvalResolved(String)
        case done
        case failed(String)
        /** The gateway's out of reach; the run goes on there, to be picked up again later. */
        case detached
    }

    static let keyName = "openclaw-device-key"
    static let deviceTokenName = "openclaw-device-token"
    static let tokenName = "openclaw-token"
    static let bootstrapName = "openclaw-bootstrap-token"

    private static let scopes = ["operator.read", "operator.write", "operator.approvals"]
    private static let connectTimeout: TimeInterval = 8
    /** How long a run may go quiet before asking the gateway whether it's still going. */
    private static let quietSeconds: TimeInterval = 60
    /** Waits between tries to get the gateway back when the socket drops mid-run. */
    private static let reconnectDelays: [TimeInterval] = [1, 2, 5, 10, 20, 30]

    let url: URL
    private let secrets: Secrets
    private let appVersion: String

    init(url: URL, secrets: Secrets, appVersion: String) {
        self.url = url
        self.secrets = secrets
        self.appVersion = appVersion
    }

    /** `chris-agent-01.tail1234.ts.net`, `https://…` → `wss://…`. */
    static func normalized(_ raw: String) -> String {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let lower = trimmed.lowercased()
        if lower.hasPrefix("ws://") || lower.hasPrefix("wss://") { return trimmed }
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") { return "ws" + trimmed.dropFirst(4) }
        return "wss://\(trimmed)"
    }

    /** A setup code (`openclaw qr --setup-code-only`): base64url JSON of the address and a one-time token. */
    static func setupCode(_ code: String) -> (url: String, bootstrapToken: String, expires: Date?)? {
        var base64 = code.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let url = json["url"] as? String, let token = json["bootstrapToken"] as? String
        else { return nil }
        return (url, token, (json["expiresAtMs"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) })
    }

    // ── Device identity ──────────────────────────────────────────────────────

    private lazy var key: Curve25519.Signing.PrivateKey = {
        if let saved = secrets.get(Self.keyName), let raw = Data(base64Encoded: saved),
           let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) { return key }
        let key = Curve25519.Signing.PrivateKey()
        secrets.set(Self.keyName, key.rawRepresentation.base64EncodedString())
        return key
    }()

    /** The key's SHA-256, as the gateway names devices. */
    private var deviceID: String {
        SHA256.hash(data: key.publicKey.rawRepresentation).map { String(format: "%02x", $0) }.joined()
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /** There's a way in: a token, a setup code, or the device token from an earlier pairing. */
    var hasCredentials: Bool {
        [Self.tokenName, Self.bootstrapName, Self.deviceTokenName].contains { secrets.get($0)?.isEmpty == false }
    }

    // ── Connection ───────────────────────────────────────────────────────────

    /** The approval this iPhone waits for on the gateway (`openclaw devices approve <id>`). */
    private(set) var pairingRequest: String?

    private var socket: URLSessionWebSocketTask?
    private var ready: Task<Void, Error>?
    private var challenge: CheckedContinuation<(nonce: String, ts: Int), Error>?
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var requestCount = 0
    private var listeners: [UUID: (String, [String: Any]) -> Void] = [:]
    private var closeListeners: [UUID: () -> Void] = [:]

    /** Connected to the gateway, connecting first when needed. */
    func connected() async throws {
        if let ready { return try await ready.value }
        let attempt = Task { try await open() }
        ready = attempt
        do { try await attempt.value } catch {
            if ready == attempt { ready = nil }
            throw error
        }
    }

    /** Closes the socket; the next request reconnects. */
    func disconnect() {
        let socket = socket
        closed(socket)
        socket?.cancel(with: .normalClosure, reason: nil)
    }

    private func open() async throws {
        let socket = URLSession.shared.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
        Task { await receive(socket) }
        let (nonce, ts) = try await within(Self.connectTimeout) {
            try await withCheckedThrowingContinuation { self.challenge = $0 }
        } onTimeout: {
            self.challenge?.resume(throwing: Failure(code: "unreachable", message: "The gateway didn't answer."))
            self.challenge = nil
        }

        let token = secrets.get(Self.tokenName).flatMap { $0.isEmpty ? nil : $0 }
        let bootstrap = secrets.get(Self.bootstrapName).flatMap { $0.isEmpty ? nil : $0 }
        let deviceToken = secrets.get(Self.deviceTokenName).flatMap { $0.isEmpty ? nil : $0 }
        // A setup code's one-time token wins; then the gateway token; then the device's own.
        let auth: [String: String]
        let signed: String
        if let bootstrap { auth = ["bootstrapToken": bootstrap]; signed = bootstrap }
        else if let token { auth = ["token": token]; signed = token }
        else if let deviceToken { auth = ["deviceToken": deviceToken]; signed = deviceToken }
        else { throw Failure(code: "not_configured", message: "Paste a setup code to connect.") }

        let client: [String: Any] = [
            "id": "gateway-client", "mode": "ui", "displayName": "Otter Mail (iPhone)",
            "version": appVersion, "platform": "ios",
        ]
        let payload = ["v3", deviceID, "gateway-client", "ui", "operator", Self.scopes.joined(separator: ","),
                       String(ts), signed, nonce, "ios", ""].joined(separator: "|")
        let signature = try key.signature(for: Data(payload.utf8))
        let hello: [String: Any]
        do {
            hello = try await request("connect", [
                "minProtocol": 4, "maxProtocol": 4, "client": client, "role": "operator",
                "scopes": Self.scopes, "caps": ["tool-events", "exec-approvals"], "auth": auth,
                "device": [
                    "id": deviceID, "publicKey": Self.base64url(key.publicKey.rawRepresentation),
                    "signature": Self.base64url(signature), "signedAt": ts, "nonce": nonce,
                ],
            ], timeout: Self.connectTimeout) as? [String: Any] ?? [:]
        } catch let failure as Failure {
            if failure.code == "PAIRING_REQUIRED" { pairingRequest = failure.requestID }
            disconnect()
            throw failure
        } catch {
            disconnect()
            throw error
        }
        pairingRequest = nil
        if let issued = (hello["auth"] as? [String: Any])?["deviceToken"] as? String, !issued.isEmpty {
            secrets.set(Self.deviceTokenName, issued)
            // The device token replaces the one-time setup code.
            if bootstrap != nil { secrets.set(Self.bootstrapName, nil) }
        }
    }

    private func receive(_ socket: URLSessionWebSocketTask) async {
        // Pieces of one message (some WebSocket stacks hand them over separately) are joined until they parse.
        var partial = ""
        while true {
            let message: URLSessionWebSocketTask.Message
            do { message = try await socket.receive() } catch {
                closed(socket)
                return
            }
            guard self.socket === socket else { return }
            let text: String
            switch message {
            case .string(let string): text = string
            case .data(let data): text = String(decoding: data, as: UTF8.self)
            @unknown default: continue
            }
            partial += text
            guard let frame = try? JSONSerialization.jsonObject(with: Data(partial.utf8)) as? [String: Any] else { continue }
            partial = ""
            handle(frame)
        }
    }

    private func handle(_ frame: [String: Any]) {
        switch frame["type"] as? String {
        case "event":
            let name = frame["event"] as? String ?? ""
            let payload = frame["payload"] as? [String: Any] ?? [:]
            if name == "connect.challenge" {
                guard let nonce = payload["nonce"] as? String, !nonce.isEmpty else { return }
                let ts = (payload["ts"] as? NSNumber)?.intValue ?? Int(Date().timeIntervalSince1970 * 1000)
                challenge?.resume(returning: (nonce, ts))
                challenge = nil
                return
            }
            for listener in listeners.values { listener(name, payload) }
        case "res":
            guard let id = frame["id"] as? String, let waiting = pending.removeValue(forKey: id) else { return }
            if frame["ok"] as? Bool == true {
                let data = (try? JSONSerialization.data(withJSONObject: frame["payload"] ?? NSNull(), options: .fragmentsAllowed)) ?? Data()
                waiting.resume(returning: data)
            } else {
                let error = frame["error"] as? [String: Any] ?? [:]
                let details = error["details"] as? [String: Any] ?? [:]
                var failure = Failure(code: details["code"] as? String ?? error["code"] as? String,
                                      message: error["message"] as? String ?? "The gateway refused.")
                failure.requestID = details["requestId"] as? String
                waiting.resume(throwing: failure)
            }
        default:
            break
        }
    }

    private func closed(_ socket: URLSessionWebSocketTask?) {
        guard let socket, self.socket === socket else { return }
        self.socket = nil
        ready = nil
        challenge?.resume(throwing: Failure(code: "unreachable", message: "Can't reach the gateway."))
        challenge = nil
        let waiting = pending
        pending = [:]
        for continuation in waiting.values {
            continuation.resume(throwing: Failure(code: "unreachable", message: "Lost the gateway."))
        }
        for listener in closeListeners.values { listener() }
    }

    /** A gateway method; its payload as JSON (a dictionary, an array, …). */
    @discardableResult
    func request(_ method: String, _ params: [String: Any], timeout: TimeInterval = 30) async throws -> Any? {
        if method != "connect" { try await connected() }
        guard let socket else { throw Failure(code: "unreachable", message: "Can't reach the gateway.") }
        requestCount += 1
        let id = "otter-mail-ios-\(requestCount)"
        let frame = try JSONSerialization.data(withJSONObject: ["type": "req", "id": id, "method": method, "params": params])
        let data = try await within(timeout) {
            try await withCheckedThrowingContinuation { continuation in
                self.pending[id] = continuation
                socket.send(.string(String(decoding: frame, as: UTF8.self))) { error in
                    guard error != nil else { return }
                    Task { @MainActor in
                        self.pending.removeValue(forKey: id)?
                            .resume(throwing: Failure(code: "unreachable", message: "Lost the gateway."))
                    }
                }
            }
        } onTimeout: {
            self.pending.removeValue(forKey: id)?
                .resume(throwing: Failure(code: "timeout", message: "The gateway didn't answer."))
        }
        return try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
    }

    /** `work`, with `onTimeout` settling whatever it waits on after `seconds`. */
    private func within<T: Sendable>(_ seconds: TimeInterval, _ work: () async throws -> T,
                                     onTimeout: @escaping () -> Void) async throws -> T {
        let timer = Task {
            try await Task.sleep(for: .seconds(seconds))
            onTimeout()
        }
        defer { timer.cancel() }
        return try await work()
    }

    // ── The gateway ──────────────────────────────────────────────────────────

    func agents() async throws -> [GatewayAgent] {
        let result = try await request("agents.list", [:]) as? [String: Any] ?? [:]
        let defaultID = result["defaultId"] as? String ?? "main"
        return (result["agents"] as? [[String: Any]] ?? []).compactMap { agent in
            guard let id = agent["id"] as? String else { return nil }
            let name = (agent["identity"] as? [String: Any])?["name"] as? String ?? agent["name"] as? String ?? id
            return GatewayAgent(id: id, name: name, isDefault: id == defaultID)
        }
    }

    /** The gateway's conversations, newest first (not cron runs or sub-agents). */
    func chats(limit: Int = 50) async throws -> [Chat] {
        let result = try await request("sessions.list", [
            "limit": limit, "includeDerivedTitles": true, "includeLastMessage": true,
            "excludeCron": true, "excludeSubagents": true, "excludeSystem": true,
        ]) as? [String: Any] ?? [:]
        return (result["sessions"] as? [[String: Any]] ?? []).compactMap { row in
            guard let id = row["key"] as? String else { return nil }
            let title = [row["derivedTitle"], row["displayName"], row["label"]].compactMap { $0 as? String }.first { !$0.isEmpty }
            return Chat(id: id, title: title ?? (row["isMain"] as? Bool == true ? "Main chat" : nil),
                        preview: row["lastMessagePreview"] as? String,
                        lastActive: Date(timeIntervalSince1970: ((row["updatedAt"] as? Double) ?? 0) / 1000))
        }
    }

    func messages(of session: String) async throws -> [Message] {
        let result = try await request("chat.history", ["sessionKey": session, "limit": 500]) as? [String: Any] ?? [:]
        return Self.transcript(result["messages"] as? [[String: Any]] ?? [])
    }

    func delete(session: String) async throws {
        try await request("sessions.delete", ["key": session])
    }

    /** Asks the gateway to stop the run. */
    func abort(session: String, run: String) async {
        _ = try? await request("chat.abort", ["sessionKey": session, "runId": run])
    }

    /** A message for the running turn: it lands after the current tool calls. */
    func steer(session: String, _ message: String) async -> Bool {
        (try? await request("chat.send", [
            "sessionKey": session, "message": message, "idempotencyKey": UUID().uuidString, "queueMode": "steer",
        ])) != nil
    }

    func approve(_ id: String, choice: String) async throws {
        let decision = ["always": "allow-always", "deny": "deny"][choice] ?? "allow-once"
        try await request("exec.approval.resolve", ["id": id, "decision": decision])
    }

    // ── Transcripts ──────────────────────────────────────────────────────────

    /** Transcript rows as the chat shows them (tool results folded into their calls). */
    static func transcript(_ rows: [[String: Any]]) -> [Message] {
        // A model's own wrapper around a tool (Codex's `exec`) is mirrored beside
        // the real call; the gateway marks its result as the provider's response.
        let mirrored = Set(rows.compactMap { row -> String? in
            let meta = (row["__openclaw"] as? [String: Any])?["toolOutput"] as? [String: Any]
            guard row["role"] as? String == "toolResult", meta?["source"] as? String == "provider-response" else { return nil }
            return row["toolCallId"] as? String
        })
        var messages: [Message] = []
        for row in rows {
            switch row["role"] as? String {
            case "user":
                messages.append(Message(role: "user", text: text(row["content"])))
            case "assistant":
                let parts = row["content"] as? [[String: Any]] ?? []
                let steps = parts.filter { $0["type"] as? String == "toolCall" }.compactMap { part -> Step? in
                    let id = part["id"] as? String
                    if let id, mirrored.contains(id) { return nil }
                    return Step(id: id, name: stepName(part["name"] as? String ?? "tool", part["arguments"]))
                }
                let said = text(row["content"])
                if !said.isEmpty || !steps.isEmpty { messages.append(Message(role: "assistant", text: said, steps: steps)) }
            case "toolResult":
                guard let id = row["toolCallId"] as? String, !mirrored.contains(id),
                      let m = messages.lastIndex(where: { $0.steps.contains { $0.id == id } }),
                      let s = messages[m].steps.firstIndex(where: { $0.id == id })
                else { break }
                let output = text(row["content"])
                messages[m].steps[s].output = output.isEmpty ? (row["isError"] as? Bool == true ? "(failed)" : "(done)") : String(output.prefix(400))
            default:
                break
            }
        }
        return messages
    }

    /** A row's text: a string, or its text parts. */
    static func text(_ content: Any?) -> String {
        if let text = content as? String { return text }
        return (content as? [[String: Any]] ?? [])
            .filter { $0["type"] as? String == "text" }
            .compactMap { $0["text"] as? String }
            .joined()
    }

    /** "Ran git status" for a shell command, else the tool's name in words. */
    static func stepName(_ name: String, _ args: Any?) -> String {
        if ["exec", "bash", "shell"].contains(name), let command = (args as? [String: Any])?["command"] as? String {
            return "Ran \(command.components(separatedBy: "\n").first ?? command)"
        }
        let words = name.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    private static func sendKey(_ row: [String: Any]) -> String? {
        let key = (row["__openclaw"] as? [String: Any])?["idempotencyKey"] as? String ?? row["idempotencyKey"] as? String
        guard let key else { return nil }
        return key.hasSuffix(":user") ? String(key.dropLast(5)) : key
    }

    /** Where a run stands: whether the gateway got its message, what it wrote since, whether it's going. */
    private struct RunState {
        var found: Bool
        var reply: Reply
        var active: Bool
    }

    private func state(session: String, run: String) async throws -> RunState {
        let result = try await request("chat.history", ["sessionKey": session, "limit": 200]) as? [String: Any] ?? [:]
        let rows = result["messages"] as? [[String: Any]] ?? []
        let info = result["sessionInfo"] as? [String: Any] ?? [:]
        let start = rows.lastIndex { $0["role"] as? String == "user" && Self.sendKey($0) == run }
        var reply = Reply()
        if let start {
            for message in Self.transcript(Array(rows[(start + 1)...])) where message.role == "assistant" {
                if !message.text.isEmpty { reply.text += (reply.text.isEmpty ? "" : "\n\n") + message.text }
                reply.steps += message.steps
            }
        }
        // `activeRunIds` is the exact set when the gateway knows it; mid-run it may only say `hasActiveRun`.
        let active = (info["activeRunIds"] as? [String]).map { $0.contains(run) } ?? (info["hasActiveRun"] as? Bool ?? false)
        return RunState(found: start != nil, reply: reply, active: active)
    }

    // ── Runs ─────────────────────────────────────────────────────────────────

    /** Sends a message and follows its run. `run` is the idempotency key, and so the run's id. */
    func send(_ message: String, session: String, run: String) -> AsyncStream<Event> {
        follow(session: session, run: run) { [self] in
            try await request("chat.send", ["sessionKey": session, "message": message, "idempotencyKey": run])
        }
    }

    /**
     * Picks up a run sent earlier (the app was in the background, or quit):
     * the reply as far as it got, then the rest if it's still going.
     */
    func resume(session: String, run: String) -> AsyncStream<Event> {
        follow(session: session, run: run, picking: true, start: nil)
    }

    /**
     * Follows a run until it ends. The gateway sends every connection its
     * sessions' events, so when the socket drops the run is picked up on the
     * next one, and what went unseen is read from the transcript. A run that
     * goes quiet (a long command) is asked after, not given up on.
     */
    private func follow(session: String, run: String, picking: Bool = false,
                        start: (() async throws -> Void)?) -> AsyncStream<Event> {
        AsyncStream { continuation in
            let work = Task { @MainActor [self] in
                // What the transcript had last time it was read, and what's streamed since.
                var base = Reply()
                var live: [(id: String, text: String)] = []
                var liveSteps: [Step] = []
                var seen = Set<String>()
                var lastShown = Reply()
                var activity = Date()
                var ended = false
                var dropped = false

                func show() {
                    var reply = base
                    for item in live where !item.text.isEmpty {
                        reply.text += (reply.text.isEmpty ? "" : "\n\n") + item.text
                    }
                    reply.steps += liveSteps
                    guard reply != lastShown else { return }
                    lastShown = reply
                    continuation.yield(.reply(reply))
                }
                func catchUp(_ state: RunState) {
                    base = state.reply
                    live = []
                    liveSteps = []
                    show()
                }
                func finish(_ event: Event) {
                    guard !ended else { return }
                    ended = true
                    continuation.yield(event)
                }

                let listener = UUID()
                listeners[listener] = { name, payload in
                    guard !ended else { return }
                    if name == "exec.approval.requested" {
                        let request = payload["request"] as? [String: Any] ?? [:]
                        guard request["sessionKey"] as? String == session, let id = payload["id"] as? String else { return }
                        continuation.yield(.approval(Approval(id: id, command: request["command"] as? String ?? request["commandPreview"] as? String)))
                        return
                    }
                    if name == "exec.approval.resolved", let id = payload["id"] as? String {
                        continuation.yield(.approvalResolved(id))
                        return
                    }
                    guard payload["sessionKey"] as? String == session else { return }
                    if let id = payload["runId"] as? String, id != run { return }
                    activity = Date()
                    let data = payload["data"] as? [String: Any] ?? [:]
                    switch (name, payload["stream"] as? String, payload["state"] as? String) {
                    case ("agent", "assistant", _):
                        let item = data["itemId"] as? String ?? "text"
                        let index = live.firstIndex { $0.id == item } ?? { live.append((item, "")); return live.count - 1 }()
                        if let text = data["text"] as? String { live[index].text = text }
                        else if data["replace"] as? Bool == true { live[index].text = data["delta"] as? String ?? "" }
                        else { live[index].text += data["delta"] as? String ?? "" }
                        show()
                    // Only the connection that sent the message gets `tool` events; another sees the tool as an item.
                    case ("agent", "tool", _), ("agent", "item", _):
                        if payload["stream"] as? String == "item", data["kind"] as? String != "tool" { return }
                        let id = data["toolCallId"] as? String
                        let phase = data["phase"] as? String == "start" ? "start" : ["result", "end"].contains(data["phase"] as? String) ? "done" : nil
                        guard let phase else { return }
                        if let id { guard seen.insert("\(id):\(phase)").inserted else { return } }
                        if phase == "start" {
                            liveSteps.append(Step(id: id, name: Self.stepName(data["name"] as? String ?? "tool", data["args"])))
                        } else if let i = liveSteps.lastIndex(where: { id == nil ? $0.output == nil : $0.id == id }) {
                            let failed = data["isError"] as? Bool == true || data["status"] as? String == "failed"
                            liveSteps[i].output = failed ? "(failed)" : "(done)"
                        }
                        show()
                    case ("chat", _, "final"):
                        // The end, as the transcript has it (one reply, steps with their results).
                        Task { [self] in
                            if let state = try? await self.state(session: session, run: run) { catchUp(state) }
                            finish(.done)
                        }
                    case ("chat", _, "aborted"):
                        finish(.failed("Stopped."))
                    case ("chat", _, "error"):
                        finish(.failed(payload["errorMessage"] as? String ?? "The run failed."))
                    default:
                        break
                    }
                }
                let closer = UUID()
                closeListeners[closer] = { dropped = true }
                defer {
                    listeners[listener] = nil
                    closeListeners[closer] = nil
                    continuation.finish()
                }

                do {
                    try await connected()
                    if let start {
                        try await start()
                    } else {
                        let state = try await state(session: session, run: run)
                        guard state.found else { return finish(.failed("OpenClaw never got this message; send it again.")) }
                        catchUp(state)
                        guard state.active else { return finish(.done) }
                        await askPending(session: session) { continuation.yield(.approval($0)) }
                    }
                } catch let failure as Failure where failure.code == "unreachable" || failure.code == "timeout" {
                    return finish(picking ? .detached : .failed("Can't reach the gateway. Are you on Tailscale?"))
                } catch {
                    return finish(.failed(error.localizedDescription))
                }

                while !ended && !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1))
                    if ended || Task.isCancelled { break }
                    if dropped {
                        // The socket's gone: get it back, then see where the run is.
                        dropped = false
                        var back = false
                        for delay in Self.reconnectDelays where !ended && !Task.isCancelled {
                            try? await Task.sleep(for: .seconds(delay))
                            guard let state = try? await state(session: session, run: run) else { continue }
                            catchUp(state)
                            if state.active { await askPending(session: session) { continuation.yield(.approval($0)) } }
                            else { finish(.done) }
                            back = true
                            break
                        }
                        if !back { finish(.detached) }
                        activity = Date()
                    } else if Date().timeIntervalSince(activity) > Self.quietSeconds {
                        activity = Date()
                        if let state = try? await state(session: session, run: run), !state.active {
                            catchUp(state)
                            finish(.done)
                        }
                    }
                }
            }
            continuation.onTermination = { _ in work.cancel() }
        }
    }

    /** Approvals the run asked for while nobody was listening. */
    private func askPending(session: String, _ ask: (Approval) -> Void) async {
        let pending = (try? await request("exec.approval.list", [:])) as? [[String: Any]] ?? []
        for approval in pending {
            let request = approval["request"] as? [String: Any] ?? [:]
            guard request["sessionKey"] as? String == session, let id = approval["id"] as? String else { continue }
            ask(Approval(id: id, command: request["command"] as? String ?? request["commandPreview"] as? String))
        }
    }
}
