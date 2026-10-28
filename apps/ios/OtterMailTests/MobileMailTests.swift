import Foundation
import Testing
@testable import Otter_Mail

@MainActor
struct MobileMailTests {
    private func mailbox(_ email: String = "me@example.com") -> Mailbox {
        Mailbox(email: email, name: "Me", displayName: "Personal", color: "#336699", signature: "", labels: [])
    }

    private func thread(_ id: String, labels: Set<String> = ["INBOX"], mailbox: String = "me@example.com") -> MailThread {
        let message = Message(id: "message-\(id)", from: Person(name: "Maya", email: "maya@example.com"),
                              to: [Person(name: "Me", email: mailbox)], cc: [], date: .now,
                              text: "Hello", html: nil, attachments: [], unread: true, starred: false, draft: false, headers: [:])
        return MailThread(id: id, mailbox: mailbox, subject: "Hello", labels: labels, messages: [message])
    }

    @Test func folderCachesFollowEditsAndSync() {
        let personal = mailbox(), work = mailbox("work@example.com")
        let first = thread("one"), second = thread("two", mailbox: work.email)
        let store = MailStore(preferences: Preferences(), mailboxes: [personal, work], threads: [first, second])
        for _ in 0..<2 {
            #expect(store.threads(in: .inbox, scope: personal.email).map(\.id) == [first.id])
            #expect(store.unreadCount(in: .inbox, scope: personal.email) == 1)
        }
        store.setRead(true, first.id)
        #expect(store.unreadCount(in: .inbox, scope: personal.email) == 0)
        #expect(store.threads(in: .inbox, scope: personal.email).first?.unread == false)
        store.archive(second.id)
        #expect(store.threads(in: .inbox, scope: work.email).isEmpty)
        store.undo()
        #expect(store.threads(in: .inbox, scope: work.email).count == 1)
        var fresh = second
        fresh.messages[0].unread = false
        store.upsert(threads: [fresh])
        #expect(store.unreadCount(in: .inbox, scope: work.email) == 0)
        store.remove(threadIDs: [first.id])
        #expect(store.threads(in: .inbox, scope: personal.email).isEmpty)
        #expect(store.threads(in: .inbox, scope: work.email).map(\.id) == [second.id])
    }

    @Test func undoRestoresFoldersWithoutLosingFreshMessageContent() {
        let original = thread("one", labels: ["INBOX", "Label_1"])
        let store = MailStore(preferences: Preferences(), mailboxes: [mailbox()], threads: [original])
        store.trash(original.id)
        #expect(store.threads(in: .inbox, scope: original.mailbox).isEmpty)
        var fresh = original
        fresh.messages[0].text = "Updated on another device"
        fresh.messages[0].unread = false
        fresh.labels.insert("Label_2")
        store.upsert(threads: [fresh])
        #expect(store.thread(original.id)?.labels.contains("TRASH") == true)
        store.undo()
        #expect(store.thread(original.id)?.labels == ["INBOX", "Label_1", "Label_2"])
        #expect(store.thread(original.id)?.latest.text == "Updated on another device")
        #expect(store.thread(original.id)?.unread == false)
        #expect(store.undoAction == nil)
    }

    @Test func bulkArchiveAndUndoWorkAcrossMailboxes() {
        let first = thread("one"), second = thread("two", mailbox: "work@example.com")
        let store = MailStore(preferences: Preferences(), mailboxes: [mailbox(), mailbox("work@example.com")], threads: [first, second])
        let inbox = { [first.mailbox, second.mailbox].flatMap { store.threads(in: .inbox, scope: $0) }.map(\.id) }
        store.archive([first.id, second.id])
        #expect(store.undoAction?.threads.count == 2)
        #expect(inbox().isEmpty)
        store.undo()
        #expect(inbox().count == 2)
        store.archive(first.id)
        store.commitPendingAction()
        store.undo()
        #expect(inbox() == [second.id])
    }

    @Test func recipientsHandleQuotedCommasAndRejectIncompleteAddresses() {
        let people = Draft.people("\"Doe, Jane\" <jane@example.com>; other@example.com")
        #expect(people.map(\.email) == ["jane@example.com", "other@example.com"])
        #expect(people.first?.name == "Doe, Jane")
        var draft = Draft(from: "me@example.com", bcc: "hidden@example.com")
        #expect(draft.canSend)
        draft.cc = "unfinished"
        #expect(!draft.canSend)
        draft.cc = "bad@@example.com"
        #expect(!draft.canSend)
        draft.cc = "valid@example.com"
        #expect(draft.canSend)
        #expect(!Draft.validRecipient("injected@example.com\r\nBcc: other@example.com"))
    }

    @Test func suggestionsStayInMailboxAndExcludeExistingRecipients() {
        let store = MailStore(preferences: Preferences(), mailboxes: [mailbox()], threads: [thread("one"), thread("two"), thread("other", mailbox: "work@example.com")])
        #expect(store.contacts(matching: "MAY", from: "me@example.com", excluding: []).map(\.email) == ["maya@example.com"])
        #expect(store.contacts(matching: "may", from: "me@example.com", excluding: ["maya@example.com"]).isEmpty)
        #expect(store.contacts(matching: "", from: "me@example.com", excluding: []).isEmpty)
    }

    @Test func localRecoverySurvivesRecreationWithBccAndFiles() throws {
        let namespace = "test-\(UUID())"
        let data = Data("attachment contents".utf8)
        let file = try DraftFile.imported(data, filename: "notes.txt", mimeType: "text/plain")
        defer { if let url = file.url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) } }
        let draft = Draft(from: "me@example.com", to: "maya@example.com", bcc: "hidden@example.com", files: [file], subject: "Recovered", body: "Unfinished")
        let first = MailStore(preferences: Preferences())
        first.configureRecovery(namespace: namespace)
        try first.saveRecovery(draft)
        let reopened = MailStore(preferences: Preferences())
        reopened.configureRecovery(namespace: namespace)
        defer { reopened.clearRecovery() }
        let recovered = try #require(reopened.recoveredDrafts.first?.draft)
        #expect(recovered == draft)
        #expect(try Data(contentsOf: #require(recovered.files.first?.url)) == data)
        reopened.removeRecovery(recovered)
        first.configureRecovery(namespace: namespace)
        #expect(first.recoveredDrafts.isEmpty)
    }

    @Test func unavailableMailboxDoesNotLoseRecovery() async throws {
        let store = MailStore(preferences: Preferences())
        store.configureRecovery(namespace: "test-\(UUID())")
        defer { store.clearRecovery() }
        let draft = Draft(from: "gone@example.com", to: "maya@example.com", body: "Keep this")
        try store.saveRecovery(draft)
        await #expect(throws: Draft.Failure.self) { try await store.save(draft) }
        #expect(store.recoveredDrafts.first?.draft == draft)
        #expect(store.threads.isEmpty)
    }

    @Test func mimeContainsAlternativeBodyAndBinaryAttachment() throws {
        let bytes = Data([0, 1, 2, 255, 254])
        let raw = MIME.message(from: mailbox().me, to: [Person(name: "Jane", email: "jane@example.com")], cc: [],
                               bcc: [Person(name: "", email: "hidden@example.com")],
                               files: [.init(filename: "résumé.pdf", mimeType: "application/pdf", data: bytes)],
                               subject: "Hello", text: "Plain", html: "<p>HTML</p>")
        let mime = String(decoding: raw, as: UTF8.self)
        #expect(mime.contains("multipart/mixed"))
        #expect(mime.contains("multipart/alternative"))
        #expect(mime.contains("filename*=UTF-8''r%C3%A9sum%C3%A9%2Epdf"))
        #expect(mime.contains(bytes.base64EncodedString()))
        #expect(mime.contains("Bcc: hidden@example.com"))
        let smtp = String(decoding: MIME.message(from: mailbox().me, to: [], cc: [], subject: "Hello\r\nBcc: attacker@example.com", text: "", html: ""), as: UTF8.self)
        #expect(!smtp.contains("\r\nBcc:"))
    }

    @Test func demoSaveRetainsAttachmentsAndReplacesOldDraft() async throws {
        let store = MailStore(preferences: Preferences(), mailboxes: [mailbox()])
        let file = try DraftFile.imported(Data("hello".utf8), filename: "hello.txt", mimeType: "text/plain")
        defer { if let url = file.url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) } }
        let draft = Draft(from: "me@example.com", to: "maya@example.com", bcc: "hidden@example.com", files: [file], body: "Hi")
        try await store.save(draft)
        let saved = try #require(store.threads.first)
        var resumed = Draft.resume(saved.latest, in: saved)
        #expect(resumed.bcc == draft.bcc)
        #expect(try await store.fileData(resumed.files[0], from: resumed.from) == Data("hello".utf8))
        // Forwarding can use another From account without losing the attachment's source.
        #expect(try await store.fileData(resumed.files[0], from: "other@example.com") == Data("hello".utf8))
        resumed.body = "Edited"
        try await store.save(resumed)
        #expect(store.threads.count == 1)
        #expect(store.threads.first?.messages.count == 1)
        #expect(store.threads.first?.latest.text == "Edited")
    }
}
