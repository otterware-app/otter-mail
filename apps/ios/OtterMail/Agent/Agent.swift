import Foundation
import Observation

/**
 * The agent, as on the desktop (core's agent service and the renderer's
 * chat). OpenRouter runs on the Otter server; Hermes on the user's server.
 * Chats and settings follow the account. Codex and Claude run on the Mac.
 */
@Observable
final class Agent {
    /** The account's `assistant.hermes` settings, under the desktop's names. */
    struct HermesSettings: Codable, Equatable {
        var enabled = true
        var baseUrl = ""
        var agentModel = ""
        /** `provider::model`; empty → the gateway's default. */
        var model = ""
        /** Empty → the gateway's default; "none" → off. */
        var reasoningEffort = ""
        /** Empty or "default" → standard; "priority" → fast. */
        var serviceTier = ""
        var sessions: Bool?

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
            baseUrl = try c.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
            agentModel = try c.decodeIfPresent(String.self, forKey: .agentModel) ?? ""
            model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
            reasoningEffort = try c.decodeIfPresent(String.self, forKey: .reasoningEffort) ?? ""
            serviceTier = try c.decodeIfPresent(String.self, forKey: .serviceTier) ?? ""
            sessions = try c.decodeIfPresent(Bool.self, forKey: .sessions)
        }
    }

    struct OpenRouterSettings: Codable, Equatable {
        var enabled = true
        var model = ""
        var runtimeMode = "approval-required"

        init() {}
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
            model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
            runtimeMode = try c.decodeIfPresent(String.self, forKey: .runtimeMode) ?? "approval-required"
        }
    }

    enum Status: Equatable {
        case notConfigured
        case checking
        case ready
        case failed(String)
    }

    struct Tool: Identifiable {
        let id = UUID()
        var name: String
        var output: String?
    }

    /** An agent asking before it does something: Hermes running a command. */
    struct Approval: Equatable {
        var id: String
        /** "Allow Hermes to run this command?" */
        var question: String
        /** Exactly what will happen, shown verbatim. */
        var detail: String?
        /** A command, shown as code. */
        var isCommand = false
        var reason: String?
        var choices: [String]
    }

    struct Turn: Identifiable {
        enum Role { case user, agent }
        let id = UUID()
        var role: Role
        var text: String
        var tools: [Tool] = []
        /** The conversations attached to a question (their subjects, for the chip). */
        var context: [String] = []
        var approval: Approval?
        var error: String?
    }

    // ── Settings, shared with the account ────────────────────────────────────

    var hermes: HermesSettings { didSet { settingsChanged() } }
    var openrouter: OpenRouterSettings { didSet { settingsChanged() } }
    var selected: String {
        didSet {
            guard oldValue != selected else { return }
            newChat()
            models = []
            history = []
            if !applying { section["selected"] = selected }
            settingsChanged()
            Task { await check() }
        }
    }
    private(set) var hasKey: Bool
    private(set) var hasOpenRouterKey = false
    @ObservationIgnored var relay: Relay?
    @ObservationIgnored var mailStore: () -> MailStore? = { nil }
    /** Told when the settings (`assistant`) or the key (`hermesKey`) change here, to sync them. */
    @ObservationIgnored var onChange: (String) -> Void = { _ in }
    /** The account's whole `assistant` section, kept so writes don't drop the Mac's Codex and Claude settings. */
    @ObservationIgnored private var section: [String: Any]
    @ObservationIgnored private var applying = false

    private static let settingsKey = "assistant" // stored and synced under its old name
    private static let keychainKey = "hermes-key"

    init() {
        let data = UserDefaults.standard.data(forKey: Self.settingsKey) ?? Data()
        let savedSection = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        section = savedSection
        let hermesSettings = Self.decode(savedSection["hermes"]) ?? HermesSettings()
        hermes = hermesSettings
        openrouter = Self.decode(savedSection["openrouter"]) ?? OpenRouterSettings()
        let saved = savedSection["selected"] as? String
        selected = saved == "hermes" || saved == "openrouter" ? saved! : (hermesSettings.baseUrl.isEmpty ? "openrouter" : "hermes")
        hasKey = Keychain.get(Self.keychainKey) != nil
    }

    private static func decode<T: Decodable>(_ value: Any?) -> T? {
        guard let value, let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /** The section as this device would write it. */
    var syncedSection: [String: Any] {
        var section = section
        let own = ((try? JSONSerialization.jsonObject(with: JSONEncoder().encode(hermes))) as? [String: Any]) ?? [:]
        section["hermes"] = ((section["hermes"] as? [String: Any]) ?? [:]).merging(own) { _, mine in mine }
        let router = ((try? JSONSerialization.jsonObject(with: JSONEncoder().encode(openrouter))) as? [String: Any]) ?? [:]
        section["openrouter"] = ((section["openrouter"] as? [String: Any]) ?? [:]).merging(router) { _, mine in mine }
        // Keep the Mac's local provider selection when merely syncing other settings.
        if ["openrouter", "hermes"].contains(section["selected"] as? String ?? "") || section["selected"] == nil {
            section["selected"] = selected
        }
        return section
    }

    private func settingsChanged() {
        section = syncedSection
        UserDefaults.standard.set(try? JSONSerialization.data(withJSONObject: section), forKey: Self.settingsKey)
        if !applying { onChange("assistant") }
        if !isOn && running { stop() }
    }

    /** Takes the account's settings and key (from another device). */
    func apply(section remote: [String: Any]?, key: String?) {
        applying = true
        defer { applying = false }
        if let remote {
            section = remote
            let next = Self.decode(remote["hermes"]) ?? HermesSettings()
            if next != hermes { hermes = next }
            let router = Self.decode(remote["openrouter"]) ?? OpenRouterSettings()
            if router != openrouter { openrouter = router }
            if let provider = remote["selected"] as? String, ["openrouter", "hermes"].contains(provider) { selected = provider }
        }
        if let key, key != Keychain.get(Self.keychainKey) {
            Keychain.set(Self.keychainKey, key)
            hasKey = true
        }
        Task { await check() }
    }

    var key: String? { Keychain.get(Self.keychainKey) }

    /** Connects to a Hermes server (from Settings › Agents), for every device. */
    func connect(url: String, key: String) async {
        Keychain.set(Self.keychainKey, key)
        hasKey = true
        hermes.baseUrl = Hermes.normalized(url)
        section["selected"] = "hermes"
        selected = "hermes"
        onChange("hermesKey")
        await check()
    }

    func disconnect() {
        Keychain.set(Self.keychainKey, nil)
        hasKey = false
        hermes.baseUrl = ""
        status = .notConfigured
        onChange("hermesKey")
    }

    /** Forgets the key here (the Otter account it came with signed out). */
    func forgetKey() {
        newChat()
        models = []
        history = []
        hasOpenRouterKey = false
        Keychain.set(Self.keychainKey, nil)
        hasKey = false
        status = .notConfigured
    }

    // ── Status and models ────────────────────────────────────────────────────

    private(set) var status: Status = .notConfigured
    private(set) var models: [Hermes.Model] = []

    /** Whether the phone has an agent on: Hermes, the one that runs here (Codex and Claude run on the Mac). Off, the agent's buttons go. */
    var isOn: Bool { selected == "openrouter" ? openrouter.enabled : hermes.enabled }
    var providerName: String { selected == "openrouter" ? "OpenRouter" : "Hermes" }
    var chosenModel: String {
        get { selected == "openrouter" ? openrouter.model : hermes.model }
        set { if selected == "openrouter" { openrouter.model = newValue } else { hermes.model = newValue } }
    }
    private var routerClient: OpenRouter? { relay.flatMap { try? OpenRouter(relay: $0) } }

    func connectOpenRouter(key: String) async throws {
        guard let client = routerClient else { throw Hermes.Failure(message: "Sign in to your Otter account first.") }
        let connection = try await client.connection(key: key.trimmingCharacters(in: .whitespacesAndNewlines))
        guard relay?.token == client.token else { return }
        section["selected"] = "openrouter"
        selected = "openrouter"
        openrouter.enabled = true
        models = connection.models
        hasOpenRouterKey = connection.connected
        status = connection.connected ? .ready : .notConfigured
    }

    func disconnectOpenRouter() async throws {
        guard let client = routerClient else { return }
        try await client.disconnect()
        newChat()
        hasOpenRouterKey = false
        models = []
        status = .notConfigured
    }

    private var client: Hermes? {
        guard hermes.enabled, !hermes.baseUrl.isEmpty, let key else { return nil }
        return Hermes(baseURL: Hermes.normalized(hermes.baseUrl), key: key)
    }

    func check() async {
        if selected == "openrouter" {
            guard let client = routerClient, openrouter.enabled else { status = .notConfigured; return }
            status = .checking
            do {
                let connection = try await client.connection()
                guard selected == "openrouter", relay?.token == client.token else { return }
                hasOpenRouterKey = connection.connected
                models = connection.models
                status = connection.connected ? .ready : .notConfigured
            } catch { if selected == "openrouter", relay?.token == client.token { status = .failed(error.localizedDescription) } }
            return
        }
        guard let client else { status = .notConfigured; return }
        status = .checking
        do {
            let (models, sessions) = try await client.check()
            guard selected == "hermes" else { return }
            self.models = models
            if hermes.sessions != sessions {
                applying = true
                hermes.sessions = sessions
                applying = false
            }
            status = .ready
        } catch {
            if selected == "hermes" { status = .failed("Can't reach Hermes: \(error.localizedDescription)") }
        }
    }

    /** The model new turns use: the one chosen, else the gateway's default. */
    var model: Hermes.Model? {
        models.first { $0.slug == chosenModel && !chosenModel.isEmpty } ?? models.first(where: \.isDefault) ?? models.first
    }

    private var modelFields: [String: Any] {
        var fields: [String: Any] = [:]
        let parts = hermes.model.components(separatedBy: "::")
        if parts.count == 2 {
            fields["provider"] = parts[0]
            fields["model"] = parts[1]
        }
        var options: [String: Any] = [:]
        if hermes.reasoningEffort == "none" {
            options["reasoning"] = ["enabled": false]
        } else if !hermes.reasoningEffort.isEmpty {
            options["reasoning"] = ["effort": hermes.reasoningEffort]
        }
        if !hermes.serviceTier.isEmpty, hermes.serviceTier != "default" { options["service_tier"] = hermes.serviceTier }
        if !options.isEmpty { fields["model_options"] = options }
        return fields
    }

    // ── The chat ─────────────────────────────────────────────────────────────

    private(set) var turns: [Turn] = []
    private(set) var session: String?
    private(set) var running = false
    @ObservationIgnored private var run: String?
    @ObservationIgnored private var streaming: Task<Void, Never>?
    @ObservationIgnored private var openRouterRunClient: OpenRouter?
    @ObservationIgnored private var approvalAnswer: CheckedContinuation<Bool, Never>?
    @ObservationIgnored private var allowedTools: Set<String> = []
    @ObservationIgnored private var approvalTool: String?
    @ObservationIgnored private var generation = UUID()

    func newChat() {
        stop()
        turns = []
        session = nil
        allowedTools = []
    }

    /** Asks, with the conversations as pointers (the desktop's handoff block). */
    func send(_ text: String, context: [MailContext] = []) {
        if selected == "openrouter" { sendOpenRouter(text, context: context); return }
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, !question.isEmpty || !context.isEmpty else { return }
        if running, let run {
            // Mid-turn: it lands after the current tool calls.
            Task { if await client.steer(run: run, question) { self.turns.append(Turn(role: .user, text: question)) } }
            return
        }
        turns.append(Turn(role: .user, text: question, context: context.map(\.subject)))
        turns.append(Turn(role: .agent, text: ""))
        running = true
        let message = MailContext.handoff(question, context)
        let fields = modelFields
        let generation = self.generation
        streaming = Task {
            do {
                let currentSession: String
                if let session { currentSession = session }
                else {
                    currentSession = try await client.createSession(title: String(question.prefix(60)))
                    guard self.generation == generation else { return }
                    session = currentSession
                }
                for try await event in client.turn(session: currentSession, message: message, model: fields) {
                    guard self.generation == generation else { return }
                    handle(event)
                }
            } catch is CancellationError {
            } catch {
                if self.generation == generation { updateLast { $0.error = error.localizedDescription } }
            }
            guard self.generation == generation else { return }
            running = false
            run = nil
            await loadHistory()
        }
    }

    private func sendOpenRouter(_ text: String, context: [MailContext]) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !running, openrouter.enabled, let client = routerClient, let model, let store = mailStore(),
              !question.isEmpty || !context.isEmpty else { return }
        turns.append(Turn(role: .user, text: question, context: context.map(\.subject)))
        turns.append(Turn(role: .agent, text: ""))
        let requestID = UUID().uuidString
        run = requestID
        running = true
        openRouterRunClient = client
        var body: [String: Any] = ["requestId": requestID, "input": MailContext.handoff(question, context, reader: "get_thread"),
                                   "title": String(question.prefix(60)), "model": model.slug, "tools": AgentMailTools.definitions]
        if let session { body["sessionId"] = session }
        streaming = Task { [self] in
            let tools = AgentMailTools(store: store, confirm: { [weak self] name, detail in
                guard let self, self.run == requestID, !Task.isCancelled else { return false }
                if self.openrouter.runtimeMode == "full-access" || self.allowedTools.contains(name) { return true }
                self.approvalTool = name
                let approved = await withCheckedContinuation { continuation in
                    self.approvalAnswer = continuation
                    self.updateLast { $0.approval = Approval(id: UUID().uuidString, question: "Allow OpenRouter to use \(name.replacingOccurrences(of: "_", with: " "))?", detail: detail, choices: ["once", "session", "deny"]) }
                }
                self.approvalTool = nil
                return approved && !Task.isCancelled && self.run == requestID
            })
            do {
                try await client.turn(body, event: { [weak self] value in
                    guard let self, self.run == requestID else { return }
                    switch value["type"] as? String {
                    case "session": self.session = value["sessionId"] as? String
                    case "delta": self.updateLast { $0.text += value["text"] as? String ?? "" }
                    case "tool": self.updateLast { $0.tools.append(Tool(name: (value["step"] as? [String: Any])?["title"] as? String ?? "Tool")) }
                    case "toolResult": self.handle(.toolResult(value["output"] as? String ?? ""))
                    case "error":
                        let message = (value["message"] as? String) ?? "The agent could not finish."
                        if message != "cancelled" { self.updateLast { $0.error = message.replacingOccurrences(of: "agent_error: ", with: "") } }
                    default: break
                    }
                }, tool: { name, input in await tools.run(name, input) })
            } catch is CancellationError {
            } catch {
                await client.stop(requestID)
                if run == requestID { updateLast { $0.error = error.localizedDescription } }
            }
            guard run == requestID else { return }
            running = false
            run = nil
            openRouterRunClient = nil
            await loadHistory()
        }
    }

    private func handle(_ event: Hermes.Event) {
        switch event {
        case .run(let id): run = id
        case .delta(let text): updateLast { $0.text += text }
        case .tool(let name): updateLast { $0.tools.append(Tool(name: name)) }
        case .toolResult(let output): updateLast { t in if !t.tools.isEmpty { t.tools[t.tools.count - 1].output = output } }
        case .approval(let id, let command, let reason, let choices):
            updateLast {
                $0.approval = Approval(id: id, question: "Allow Hermes to run this command?", detail: command, isCommand: true, reason: reason, choices: choices)
            }
        case .completed(let steer):
            if let steer { turns.append(Turn(role: .user, text: steer, error: "Hermes finished before this; send it again.")) }
        case .failed(let message): updateLast { $0.error = message }
        }
    }

    /** What the running turn is waiting on, shown in the composer's place. */
    var pendingApproval: Approval? { turns.last { $0.role == .agent }?.approval }

    private func updateLast(_ change: (inout Turn) -> Void) {
        guard let i = turns.lastIndex(where: { $0.role == .agent }) else { return }
        change(&turns[i])
    }

    func stop() {
        generation = UUID()
        if let run, let client = openRouterRunClient { Task { await client.stop(run) } }
        else if let run, let client { Task { await client.stop(run: run) } }
        approvalAnswer?.resume(returning: false)
        approvalAnswer = nil
        updateLast { $0.approval = nil }
        streaming?.cancel()
        streaming = nil
        running = false
        run = nil
        openRouterRunClient = nil
    }

    func answer(_ approval: Approval, _ choice: String) {
        if let answer = approvalAnswer, pendingApproval?.id == approval.id {
            if choice == "session", let tool = approvalTool { allowedTools.insert(tool) }
            approvalAnswer = nil
            updateLast { $0.approval = nil }
            answer.resume(returning: ["once", "session"].contains(choice))
            return
        }
        guard let client, let run else { return }
        Task {
            try? await client.approve(run: run, request: approval.id, choice: choice)
            updateLast { $0.approval = nil }
        }
    }

    // ── History ──────────────────────────────────────────────────────────────

    private(set) var history: [Hermes.Session] = []

    func loadHistory() async {
        if selected == "openrouter" {
            guard let client = routerClient else { return }
            let chats = try? await client.sessions()
            if selected == "openrouter", relay?.token == client.token, let chats { history = chats }
            return
        }
        guard let client else { return }
        history = (try? await client.sessions()) ?? history
    }

    func open(_ chat: Hermes.Session) async {
        newChat()
        let generation = self.generation
        let provider = selected
        let token = relay?.token
        session = chat.id
        let messages: [Hermes.Message]
        if selected == "openrouter", let client = routerClient { messages = (try? await client.messages(of: chat.id)) ?? [] }
        else if let client { messages = (try? await client.messages(of: chat.id)) ?? [] }
        else { return }
        guard self.generation == generation, selected == provider, relay?.token == token else { return }
        var turns: [Turn] = []
        for message in messages {
            switch message.role {
            case "user":
                // Show the question, not the context block sent with it.
                let text = message.text.components(separatedBy: MailContext.marker).first ?? message.text
                turns.append(Turn(role: .user, text: text.trimmingCharacters(in: .whitespacesAndNewlines)))
            case "assistant":
                if let last = turns.last, last.role == .agent {
                    turns[turns.count - 1].text += (last.text.isEmpty ? "" : "\n\n") + message.text
                    turns[turns.count - 1].tools += message.tools.map { Tool(name: $0) }
                } else {
                    turns.append(Turn(role: .agent, text: message.text, tools: message.tools.map { Tool(name: $0) }))
                }
            default:
                break
            }
        }
        self.turns = turns
    }

    func delete(_ chat: Hermes.Session) async {
        if selected == "openrouter", let client = routerClient { try? await client.delete(session: chat.id) }
        else if let client { try? await client.delete(session: chat.id) }
        else { return }
        if session == chat.id { newChat() }
        history.removeAll { $0.id == chat.id }
    }
}

/**
 * A conversation handed to the agent as a pointer (apps/web's
 * chat-context.ts): the agent reads mail itself, with gog, so only ids and a
 * subject leave the app.
 */
struct MailContext: Hashable {
    var account: String
    var threadID: String
    var subject: String
    var from: String
    var messageIDs: [String]

    static let marker = "\n\n— context from Otter Mail —"

    init(_ thread: MailThread) {
        account = thread.mailbox
        threadID = thread.id
        subject = thread.subject.isEmpty ? "(no subject)" : thread.subject
        from = thread.latest.from.email
        messageIDs = [thread.latest.id]
    }

    /** The question, then the pointer block, as the desktop sends it. */
    static func handoff(_ question: String, _ context: [MailContext], reader: String = "gog") -> String {
        guard !context.isEmpty else { return question }
        var lines = [question, "", "— context from Otter Mail —"]
        for c in context {
            lines.append("• [\(c.account)] \"\(c.subject)\" — from \(c.from) (threadId \(c.threadID), message \(c.messageIDs.joined(separator: ", ")))")
        }
        lines.append("Fetch full content with \(reader) if needed.")
        return lines.joined(separator: "\n")
    }
}
