import Foundation
import Testing
@testable import Otter_Mail

/** The account's agent chats, as the phone reads and writes them (AgentChats.swift). */
@MainActor
struct AgentChatsTests {
    @Test func listsTheAccountsChatsButNotTheDeletedOnes() {
        let chat = SyncedChat(["id": "c1", "title": "Plan the offsite", "provider": "claude", "sessionId": NSNull(),
                               "device": ["id": "d1", "name": "Robin's Mac"], "updatedAt": 1_000, "deletedAt": NSNull()])
        #expect(chat?.title == "Plan the offsite")
        #expect(chat?.device == "Robin's Mac")
        #expect(chat?.isLocalToMac == true)
        #expect(SyncedChat(["id": "c2", "title": "", "provider": "openrouter", "updatedAt": 2_000, "deletedAt": 3_000]) == nil)
    }

    @Test func showsAnAgentTurnsTextAndStepsAndWritesItsOwnBack() {
        let shown = ChatJSON.turns([
            ["id": "u-1", "role": "user", "text": "Find a venue", "context": ["subjects": ["Offsite"], "count": 1, "kind": "mail"]],
            ["id": "a-1", "role": "assistant", "text": "", "items": [
                ["kind": "step", "step": ["kind": "tool", "title": "Search mail"], "output": "[]"],
                ["kind": "text", "text": "Cedar Hall is free."],
            ]],
        ])
        #expect(shown.map(\.text) == ["Find a venue", "Cedar Hall is free."])
        #expect(shown[0].context == ["Offsite"])
        #expect(shown[1].tools.map(\.name) == ["Search mail"])

        let written = ChatJSON.objects(shown)
        #expect(written[0]["role"] as? String == "user")
        #expect(written[1]["role"] as? String == "assistant")
        let items = written[1]["items"] as? [[String: Any]] ?? []
        #expect(items.map { $0["kind"] as? String } == ["step", "text"])
        #expect(JSONSerialization.isValidJSONObject(written))
    }
}
