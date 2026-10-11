import Foundation
import Testing
@testable import Otter_Mail

/** OpenClaw's gateway, as the phone reads it (OpenClaw.swift). */
struct OpenClawTests {
    @Test func reachesTheGatewayOverItsWebSocketWhateverAddressIsPasted() {
        #expect(OpenClaw.normalized("chris-agent-01.tail1234.ts.net") == "wss://chris-agent-01.tail1234.ts.net")
        #expect(OpenClaw.normalized("https://chris-agent-01.tail1234.ts.net/") == "wss://chris-agent-01.tail1234.ts.net")
        #expect(OpenClaw.normalized("ws://127.0.0.1:18789") == "ws://127.0.0.1:18789")
    }

    @Test func readsTheAddressAndOneTimeTokenFromASetupCode() throws {
        let json = #"{"url":"wss://gw.tail1234.ts.net","bootstrapToken":"bt-1","expiresAtMs":1000}"#
        let code = Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let setup = try #require(OpenClaw.setupCode(" \(code)\n"))
        #expect(setup.url == "wss://gw.tail1234.ts.net")
        #expect(setup.bootstrapToken == "bt-1")
        #expect(setup.expires == Date(timeIntervalSince1970: 1))
        #expect(OpenClaw.setupCode("not a code") == nil)
    }

    @Test func foldsToolResultsIntoTheirCalls() {
        let rows: [[String: Any]] = [
            ["role": "user", "content": "Check the build"],
            ["role": "assistant", "content": [["type": "toolCall", "id": "c1", "name": "exec", "arguments": ["command": "make test"]]]],
            ["role": "toolResult", "toolCallId": "c1", "toolName": "exec", "content": [["type": "text", "text": "ok"]]],
            // A model's own wrapper, mirrored beside the real call.
            ["role": "assistant", "content": [["type": "toolCall", "id": "c2", "name": "exec", "arguments": [:]]]],
            ["role": "toolResult", "toolCallId": "c2", "content": "ok", "__openclaw": ["toolOutput": ["source": "provider-response"]]],
            ["role": "assistant", "content": [["type": "text", "text": "The build passes."]]],
        ]
        let messages = OpenClaw.transcript(rows)
        #expect(messages.map(\.role) == ["user", "assistant", "assistant"])
        #expect(messages[1].steps == [OpenClaw.Step(id: "c1", name: "Ran make test", output: "ok")])
        #expect(messages[2].text == "The build passes.")
    }
}
