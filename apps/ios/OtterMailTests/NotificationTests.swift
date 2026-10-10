import Foundation
import Testing
@testable import Otter_Mail

nonisolated struct NotificationTests: Sendable {
    private func data(_ json: String) -> Data { Data(json.utf8) }

    @Test func existingGoogleGrantKeepsItsOriginalClientAndTopic() throws {
        let email = "legacy-grant-test@otter.example"
        // The unsigned CI simulator has no shared-Keychain entitlement.
        var saved = [GoogleCredentials.refreshKey(email): "fake-original-refresh"]
        let credential = try #require(GoogleCredentials.credential(email, read: { saved[$0] }))
        #expect(credential.refreshToken == "fake-original-refresh")
        #expect(credential.clientID == GoogleCredentials.legacyClientID)
        #expect(GoogleCredentials.pushTopic(email, fallback: "legacy-topic", read: { saved[$0] }) == "legacy-topic")
        try #require(GoogleCredentials.save(email, credential: credential, write: { saved[$0] = $1; return true }))
        #expect(GoogleCredentials.credential(email, read: { saved[$0] })?.clientID == GoogleCredentials.legacyClientID)
    }

    @Test func newGoogleGrantRecordsItsClientAndSelectsTheNewTopic() throws {
        let email = "current-grant-test@otter.example"
        let accessKey = "google-access-token:\(email)"
        var saved = [accessKey: "fake-previous-client-access"]
        try #require(GoogleCredentials.save(email, credential: .init(refreshToken: "fake-current-refresh", clientID: GoogleCredentials.clientID), write: { saved[$0] = $1; return true }))
        #expect(saved[accessKey] == nil)
        let credential = try #require(GoogleCredentials.credential(email, read: { saved[$0] }))
        #expect(credential.refreshToken == "fake-current-refresh")
        #expect(credential.clientID == GoogleCredentials.clientID)
        #expect(GoogleCredentials.pushTopic(email, fallback: "legacy-topic", read: { saved[$0] }) == "projects/otterware/topics/gmail-push")
    }


    @Test func previewKeepsLinkLabelsAndFormattedWords() throws {
        let snippet = "[Rasur Shop](https://example.com/pages/products) [Besuchen Sie uns]\n(https://example.com/track?id=123) Lieber Laurin, **something big** is coming &amp; it’s exciting."
        let message = try JSONDecoder().decode(GmailNotification.Message.self, from: JSONSerialization.data(withJSONObject: ["id": "a", "threadId": "t", "snippet": snippet]))
        #expect(message.preview == "Rasur Shop Besuchen Sie uns Lieber Laurin, something big is coming & it’s exciting.")
    }

    @Test func previewHandlesNestedAndTruncatedDestinations() {
        #expect(MailDecoding.preview("See [the guide](https://example.com/guide_(new)) for **details**.") == "See the guide for details.")
        #expect(MailDecoding.preview("Hello [visit our shop](https://example.com/tracking?long=123") == "Hello visit our shop")
        #expect(MailDecoding.preview("Call [support](mailto:help@example.com)") == "Call support")
    }

    @Test func previewPreservesOrdinaryTextAndUnicode() {
        #expect(MailDecoding.preview("Café 🦦\n\t email first_last@example.com. 2 * 3 = 6. [pending]") == "Café 🦦 email first_last@example.com. 2 * 3 = 6. [pending]")
        #expect(MailDecoding.preview("   ").isEmpty)
        #expect(MailDecoding.preview(String(repeating: "🦦", count: 100_000), limit: 500) == String(repeating: "🦦", count: 500))
    }

    @Test func currentLabelsRespectOffInboxAll() throws {
        func message(_ labels: [String]) throws -> GmailNotification.Message {
            try JSONDecoder().decode(GmailNotification.Message.self, from: JSONSerialization.data(withJSONObject: ["id": "a", "threadId": "t", "labelIds": labels]))
        }
        #expect(try !message(["UNREAD"]).eligible("off"))
        #expect(try !message(["UNREAD"]).eligible("inbox"))
        #expect(try message(["UNREAD"]).eligible("all"))
        #expect(try message(["UNREAD", "INBOX"]).eligible("inbox"))
        for label in ["DRAFT", "SENT", "SPAM", "TRASH"] {
            #expect(try !message(["UNREAD", "INBOX", label]).eligible("all"))
        }
        #expect(try !message(["INBOX"]).eligible("all"))
    }

    @Test func successAndTimeoutCompleteExactlyOnce() async {
        let calls = Calls()
        let gate = NotificationCompletion<Int> { calls.add($0) }
        await withTaskGroup(of: Void.self) { group in
            for value in 0..<100 { group.addTask { gate.finish(value) } }
        }
        #expect(calls.count == 1)
    }
}

nonisolated private final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int] = []
    func add(_ value: Int) { lock.lock(); values.append(value); lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return values.count }
}
