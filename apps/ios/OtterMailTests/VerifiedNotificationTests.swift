import Foundation
import Testing
@testable import Otter_Mail

nonisolated struct VerifiedNotificationTests: Sendable {
    private func event(user: String = "owner", provider: String = "gmail", message: String = "abcdef", mode: String = "inbox") -> VerifiedNotification.Metadata {
        .init(version: 2, userId: user, email: "me@example.com", provider: provider, historyId: "9007199254740993", messageId: message, mode: mode)
    }
    private var config: PushState.Configuration { .init(userId: "owner", mode: "inbox", mailboxes: ["me@example.com"]) }

    @Test func providerPayloadsDecodeTheirRoutingMarkers() throws {
        for provider in ["gmail", "outlook", "imap"] {
            var payload: [String: Any] = ["version": 2, "userId": "owner", "email": "me@example.com", "provider": provider,
                                          "historyId": "9007199254740993", "messageId": provider == "imap" ? "19" : "abcdef", "mode": "inbox"]
            if provider == "imap" { payload["folder"] = "INBOX"; payload["uidValidity"] = 42 }
            let decoded = try JSONDecoder().decode(VerifiedNotification.Metadata.self, from: JSONSerialization.data(withJSONObject: payload))
            #expect(decoded.provider == provider)
            #expect(decoded.historyId == "9007199254740993")
            #expect(decoded.uidValidity == (provider == "imap" ? 42 : nil))
            #expect(decoded.folder == (provider == "imap" ? "INBOX" : nil))
        }
    }

    @Test func confirmedMessageUsesIdNotTheEventEndingMarker() async throws {
        let result = try await VerifiedNotification.enrich(event(), configuration: config) { path, query in
            #expect(path == "messages/abcdef")
            #expect(!query.contains { $0.name == "startHistoryId" })
            #expect(query.contains { $0.name == "format" && $0.value == "metadata" })
            return Data(#"{"id":"abcdef","threadId":"thread","labelIds":["INBOX","UNREAD"],"snippet":"A [useful link](https://example.com)","payload":{"headers":[{"name":"From","value":"Maya <maya@example.com>"},{"name":"Subject","value":"Hello"}]}}"#.utf8)
        }
        #expect(result?.sender == "Maya")
        #expect(result?.subject == "Hello")
        #expect(result?.preview == "A useful link")
        #expect(result?.threadId == "thread")
    }
    @Test func wrongAccountOffAndRemovedMailboxNeverFetchMail() async throws {
        let never: @Sendable (String, [URLQueryItem]) async throws -> Data = { _, _ in Issue.record("Unauthorized enrichment performed a request"); return Data() }
        #expect(try await VerifiedNotification.enrich(event(user: "other"), configuration: config, getGmail: never) == nil)
        #expect(try await VerifiedNotification.enrich(event(), configuration: .init(userId: "owner", mode: "off", mailboxes: ["me@example.com"]), getGmail: never) == nil)
        #expect(try await VerifiedNotification.enrich(event(), configuration: .init(userId: "owner", mode: "all", mailboxes: []), getGmail: never) == nil)
        #expect(try await VerifiedNotification.enrich(event(message: "../../history"), configuration: config, getGmail: never) == nil)
    }
    @Test func readOrMovedMailDoesNotGainAnEnrichedAlert() async throws {
        for labels in [["INBOX"], ["UNREAD"], ["INBOX", "UNREAD", "SENT"]] {
            let bytes = try JSONSerialization.data(withJSONObject: ["id": "abcdef", "threadId": "thread", "labelIds": labels])
            let result = try await VerifiedNotification.enrich(event(), configuration: config) { _, _ in bytes }
            #expect(result == nil)
        }
    }
    @Test func metadataAndLocalFiltersUseTheMoreRestrictiveMode() async throws {
        let bytes = Data(#"{"id":"abcdef","threadId":"thread","labelIds":["UNREAD"]}"#.utf8)
        #expect(try await VerifiedNotification.enrich(event(mode: "inbox"), configuration: .init(userId: "owner", mode: "all", mailboxes: ["me@example.com"])) { _, _ in bytes } == nil)
        let all = try await VerifiedNotification.enrich(event(mode: "all"), configuration: .init(userId: "owner", mode: "all", mailboxes: ["me@example.com"])) { _, _ in bytes }
        #expect(all?.id == "abcdef")
    }
    @Test func revokedOfflineAndCancelledFetchReturnNoFabricatedPreview() async {
        for status in [401, 403, 0] {
            await #expect(throws: GmailNotification.Failure.self) {
                try await VerifiedNotification.enrich(event(), configuration: config) { _, _ in throw GmailNotification.Failure(status: status) }
            }
        }
        let task = Task { try await VerifiedNotification.enrich(event(), configuration: config) { _, _ in
            try await Task.sleep(for: .seconds(60)); return Data()
        } }
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
    }
    @Test func imapMimePartSelectionHandlesNestedAlternativesAndEncoding() {
        let response = ImapParser.response(Data(#"1 FETCH (BODYSTRUCTURE ((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"QUOTED-PRINTABLE\" 20 1) ((\"TEXT\" \"HTML\" (\"CHARSET\" \"UTF-8\") NIL NIL \"BASE64\" 40 1) \"ALTERNATIVE\") \"MIXED\"))"#.replacingOccurrences(of: #"\""#, with: "\"").utf8))
        let structure = response.values.first?.pairs["BODYSTRUCTURE"] ?? .none
        let parts = VerifiedNotification.parts(structure)
        #expect(parts.map(\.path) == ["1", "2.1"])
        #expect(parts.first?.html == false)
        #expect(parts.first?.encoding == "QUOTED-PRINTABLE")
        #expect(parts.last?.charset == "UTF-8")
    }
}
