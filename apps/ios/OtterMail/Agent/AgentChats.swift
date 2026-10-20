import Foundation

/**
 * The account's agent chats (contracts' chats.ts), synced through the relay:
 * every chat reads the same here, whatever agent ran it and on which device.
 * One this iPhone's agent can run continues here; the others (Claude and
 * Codex on a Mac, or another agent than the one picked) are read. Chats stay
 * the relay's JSON, so one written back keeps what other devices wrote (its
 * tabs, results, context), with this iPhone's turns after theirs.
 */
struct SyncedChat: Identifiable, Equatable {
    var id: String
    var title: String
    var provider: String
    var sessionId: String?
    /** The Mac a Claude or Codex chat ran on. */
    var device: String?
    var updatedAt: Date

    /** A chat from the relay's list; nil for one deleted. */
    init?(_ object: [String: Any]) {
        guard let id = object["id"] as? String, object["deletedAt"] as? NSNumber == nil else { return nil }
        self.id = id
        title = object["title"] as? String ?? "Untitled chat"
        provider = object["provider"] as? String ?? ""
        sessionId = object["sessionId"] as? String
        device = (object["device"] as? [String: Any])?["name"] as? String
        updatedAt = Date(timeIntervalSince1970: ((object["updatedAt"] as? NSNumber)?.doubleValue ?? 0) / 1000)
    }

    /** The agent's name, as the chat list says it. */
    var providerName: String { Self.providerNames[provider] ?? provider.capitalized }

    static let providerNames = [
        "openrouter": "OpenRouter", "hermes": "Hermes", "openclaw": "OpenClaw", "claude": "Claude", "codex": "Codex",
    ]

    /** Claude and Codex run on one Mac: their chats continue there. */
    var isLocalToMac: Bool { provider == "claude" || provider == "codex" }
}

/** Turns between the relay's JSON and what the iPhone shows. */
enum ChatJSON {
    static var now: Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }

    /** The relay's turns as the iPhone shows them: an agent turn's text, and its steps as tools. */
    static func turns(_ objects: [[String: Any]]) -> [Agent.Turn] {
        objects.map { turn in
            if turn["role"] as? String == "user" {
                let subjects = (turn["context"] as? [String: Any])?["subjects"] as? [String] ?? []
                return Agent.Turn(role: .user, text: turn["text"] as? String ?? "", context: subjects)
            }
            let items = turn["items"] as? [[String: Any]] ?? []
            let text = items.filter { $0["kind"] as? String == "text" }.compactMap { $0["text"] as? String }
            let tools = items.filter { $0["kind"] as? String == "step" }.map { item in
                Agent.Tool(name: (item["step"] as? [String: Any])?["title"] as? String ?? "Tool", output: item["output"] as? String)
            }
            return Agent.Turn(role: .agent, text: text.joined(separator: "\n\n"), tools: tools, error: turn["error"] as? String)
        }
    }

    /** The iPhone's turns as the relay keeps them (contracts' ChatTurn). */
    static func objects(_ turns: [Agent.Turn]) -> [[String: Any]] {
        turns.map { turn in
            var object: [String: Any] = ["id": turn.id.uuidString.lowercased()]
            if turn.role == .user {
                object["role"] = "user"
                object["text"] = turn.text
                if !turn.context.isEmpty {
                    object["context"] = ["subjects": turn.context, "count": turn.context.count, "kind": "mail"]
                }
                return object
            }
            object["role"] = "assistant"
            object["text"] = ""
            var items: [[String: Any]] = turn.tools.map { tool in
                var item: [String: Any] = ["kind": "step", "step": ["kind": "tool", "title": tool.name]]
                if let output = tool.output { item["output"] = String(output.prefix(4000)) }
                return item
            }
            if !turn.text.isEmpty { items.append(["kind": "text", "text": turn.text]) }
            object["items"] = items
            if let error = turn.error { object["error"] = error }
            object["finishedAt"] = now
            return object
        }
    }
}
