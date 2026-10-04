import Foundation
import Testing
@testable import Otter_Mail

nonisolated struct NotificationTests: Sendable {
    private func data(_ json: String) -> Data { Data(json.utf8) }

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

    @Test func usesSavedStartCursorAndPaginatesAddedMessages() async throws {
        let api = GmailNotification { path, query in
            if path == "history" {
                #expect(query.first { $0.name == "startHistoryId" }?.value == "100")
                #expect(query.first { $0.name == "historyTypes" }?.value == "messageAdded")
                if query.contains(where: { $0.name == "pageToken" }) {
                    return data(#"{"historyId":"205","history":[{"messagesAdded":[{"message":{"id":"b"}}]}]}"#)
                }
                return data(#"{"historyId":"205","nextPageToken":"page","history":[{"messagesAdded":[{"message":{"id":"a"}}]}]}"#)
            }
            #expect(query.contains { $0.name == "format" && $0.value == "metadata" })
            #expect(query.contains { $0.name == "fields" && $0.value?.contains("snippet") == true })
            let id = path.hasSuffix("b") ? "b" : "a"
            let date = id == "b" ? "2000" : "1000"
            return data("{\"id\":\"\(id)\",\"threadId\":\"thread-\(id)\",\"internalDate\":\"\(date)\",\"labelIds\":[\"UNREAD\",\"INBOX\"],\"snippet\":\"Private preview\",\"payload\":{\"headers\":[{\"name\":\"From\",\"value\":\"Maya\"},{\"name\":\"Subject\",\"value\":\"Hello\"}]}}")
        }
        let result = try await api.enrich(baseline: "100", eventHistoryId: "200", mode: "inbox")
        #expect(result.historyId == "205")
        #expect(result.message?.id == "b")
        #expect(result.message?.header("Subject") == "Hello")
        #expect(result.count == 2)
    }

    @Test func readArchiveAndLabelChangesDoNotBecomeNewMail() async throws {
        let api = GmailNotification { path, _ in
            #expect(path == "history")
            return data(#"{"historyId":"200","history":[{"labelsAdded":[{"message":{"id":"a"}}]}]}"#)
        }
        let result = try await api.enrich(baseline: "100", eventHistoryId: "200", mode: "all")
        #expect(result.message == nil)
        #expect(result.historyId == "200")
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

    @Test func missingAndExpiredHistoryRebaseWithoutAnnouncingOldMail() async throws {
        for baseline in [nil, "100"] as [String?] {
            let api = GmailNotification { path, _ in
                if path == "history" { throw GmailNotification.Failure(status: 404) }
                #expect(path == "profile")
                return data(#"{"historyId":"300"}"#)
            }
            let result = try await api.enrich(baseline: baseline, eventHistoryId: "200", mode: "all")
            #expect(result.historyId == "300")
            #expect(result.message == nil)
        }
    }

    @Test func repeatedOrOlderMarkerMakesNoRequests() async throws {
        let api = GmailNotification { _, _ in Issue.record("A repeated change should make no requests"); throw GmailNotification.Failure(status: 0) }
        let result = try await api.enrich(baseline: "9007199254740993", eventHistoryId: "9007199254740992", mode: "all")
        #expect(result.message == nil)
        #expect(result.historyId == "9007199254740993")
        #expect(GmailNotification.newer("9007199254740993", than: "9007199254740992"))
    }

    @Test func incompleteOrOfflineHistoryDoesNotReturnACommitCursor() async {
        for status in [0, 401, 403] {
            let api = GmailNotification { _, _ in throw GmailNotification.Failure(status: status) }
            await #expect(throws: GmailNotification.Failure.self) {
                try await api.enrich(baseline: "100", eventHistoryId: "200", mode: "all")
            }
        }
        let huge = GmailNotification { _, _ in data(#"{"historyId":"200","nextPageToken":"more"}"#) }
        await #expect(throws: GmailNotification.Failure.self) { try await huge.enrich(baseline: "100", eventHistoryId: "200", mode: "all") }
    }

    @Test func cancelledWorkCannotCompleteHistory() async {
        let api = GmailNotification { _, _ in
            try await Task.sleep(for: .seconds(60))
            return Data()
        }
        let work = Task { try await api.enrich(baseline: "100", eventHistoryId: "200", mode: "all") }
        work.cancel()
        await #expect(throws: CancellationError.self) { try await work.value }
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
