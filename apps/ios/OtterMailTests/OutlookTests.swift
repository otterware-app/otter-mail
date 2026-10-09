import Foundation
import Testing
@testable import Otter_Mail

/** Outlook through Graph: labels as core gives them, search, MIME sources, and delta paging (docs/outlook.md). */
struct OutlookTests {
    private let me = "me@contoso.com"

    private func folder(_ id: String, _ name: String, children: Int = 0) -> OutlookFolders.ApiFolder {
        OutlookFolders.ApiFolder(id: id, displayName: name, childFolderCount: children)
    }

    private var box: OutlookFolders {
        OutlookFolders(
            wellKnown: ["inbox": "I", "sentitems": "S", "drafts": "D", "deleteditems": "T", "junkemail": "J", "archive": "A", "outbox": "O"],
            children: [
                nil: [
                    folder("I", "Inbox", children: 1), folder("S", "Sent Items"), folder("D", "Drafts"),
                    folder("T", "Deleted Items", children: 1), folder("J", "Junk Email"), folder("A", "Archive"),
                    folder("O", "Outbox"), folder("P", "Projects", children: 1),
                ],
                "I": [folder("IC", "Clients")],
                "T": [folder("TO", "Old")],
                "P": [folder("PA", "Acme")],
            ],
            categories: [.init(name: "Red", color: "preset0"), .init(name: "Plain", color: "none")]
        )
    }

    private func message(_ json: String) throws -> GraphMessage {
        try JSONDecoder().decode(GraphMessage.self, from: Data(json.utf8))
    }

    // ── Labels ───────────────────────────────────────────────────────────────

    @Test func foldersAreCoreLabels() {
        let box = self.box
        #expect(box.label(ofFolder: "I") == "INBOX")
        #expect(box.label(ofFolder: "S") == "SENT")
        #expect(box.label(ofFolder: "D") == "DRAFT")
        #expect(box.label(ofFolder: "T") == "TRASH")
        #expect(box.label(ofFolder: "J") == "SPAM")
        #expect(box.label(ofFolder: "A") == nil)
        // Deleted Items' folders are trash too; other folders are labels of their own.
        #expect(box.label(ofFolder: "TO") == "TRASH")
        #expect(box.label(ofFolder: "IC") == "folder:IC")
        #expect(box.label(ofFolder: "PA") == "folder:PA")
        #expect(box.label(ofFolder: "new") == "folder:new")
        #expect(!box.isSynced("O"))
        #expect(box.isSynced("I") && box.isSynced(nil))
        #expect(box.folders.first?.id == "I")
        #expect(box.folders.last?.label == "TRASH")
        #expect(box.folder(ofLabel: "TRASH") == "T")
        #expect(box.folder(ofLabel: "folder:PA") == "PA")
        #expect(box.folder(ofLabel: "category:Red") == nil)
        #expect(box.folder(ofLabel: "STARRED") == nil)
    }

    @Test func sidebarListsFoldersByPathThenCategoriesInTheirColors() {
        let labels = box.labels
        #expect(labels.map(\.id) == ["folder:IC", "folder:P", "folder:PA", "category:Plain", "category:Red"])
        #expect(labels.map(\.name) == ["Inbox/Clients", "Projects", "Projects/Acme", "Plain", "Red"])
        #expect(labels.first { $0.id == "folder:PA" }?.depth == 1)
        #expect(labels.first { $0.id == "category:Red" }?.color == "#e74856")
        #expect(labels.first { $0.id == "category:Plain" }?.color == nil)
    }

    @Test func messagesWearTheirFolderFlagsAndCategories() throws {
        let received = try message(#"""
        {"id":"m1","conversationId":"c1","subject":"Hi","parentFolderId":"I","isRead":false,"isDraft":false,
         "flag":{"flagStatus":"flagged"},"importance":"high","categories":["Red"],"receivedDateTime":"2026-10-01T10:00:00Z",
         "from":{"emailAddress":{"name":"Ann","address":"ann@example.com"}},"toRecipients":[{"emailAddress":{"name":"Me","address":"me@contoso.com"}}]}
        """#)
        #expect(box.labels(of: received) == ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "category:Red"])
        let reply = try message(#"""
        {"id":"m2","conversationId":"c1","subject":"RE: Hi","parentFolderId":"S","isRead":true,"isDraft":false,
         "receivedDateTime":"2026-10-01T11:00:00Z","from":{"emailAddress":{"name":"Me","address":"me@contoso.com"}}}
        """#)
        let outbox = try message(#"{"id":"m3","conversationId":"c1","parentFolderId":"O","receivedDateTime":"2026-10-01T12:00:00Z"}"#)
        let thread = try #require(OutlookMail.thread("c1", [reply, outbox, received], mailbox: me, folders: box, contents: [:], known: [:]))
        #expect(thread.subject == "Hi")
        #expect(thread.messages.map(\.id) == ["m1", "m2"])
        #expect(thread.labels == ["INBOX", "SENT", "IMPORTANT", "category:Red"])
        #expect(thread.unread && thread.starred)
        #expect(thread.messages[0].from == Person(name: "Ann", email: "ann@example.com"))
        // Only the Outbox's: nothing to show.
        #expect(OutlookMail.thread("c2", [outbox], mailbox: me, folders: box, contents: [:], known: [:]) == nil)
    }

    @Test func labelChangesArePatchesAndMoves() throws {
        let box = self.box
        let received = try message(#"{"id":"m1","parentFolderId":"I","isRead":false,"categories":["Red"],"from":{"emailAddress":{"address":"ann@example.com"}}}"#)
        let sent = try message(#"{"id":"m2","parentFolderId":"S","isRead":true,"from":{"emailAddress":{"address":"me@contoso.com"}}}"#)
        let move = { (message: GraphMessage, add: [String], remove: [String], whole: Bool) in
            OutlookMail.destination(message, add: add, remove: remove, wholeThread: whole, mailbox: self.me, folders: box)
        }
        // Archive: out of the inbox; your sent mail stays in Sent.
        #expect(move(received, [], ["INBOX"], true) == "A")
        #expect(move(sent, [], ["INBOX"], true) == nil)
        // Trash takes everything; Junk leaves your own.
        #expect(move(received, ["TRASH"], ["INBOX"], true) == "T")
        #expect(move(sent, ["TRASH"], [], true) == "T")
        #expect(move(received, ["SPAM"], ["INBOX"], true) == "J")
        #expect(move(sent, ["SPAM"], ["INBOX"], true) == nil)
        // Into a folder; out of one, to the Archive.
        #expect(move(received, ["folder:PA"], [], true) == "PA")
        let filed = try message(#"{"id":"m3","parentFolderId":"PA"}"#)
        #expect(move(filed, [], ["folder:PA"], true) == "A")
        // Restored from Deleted Items: yours to Sent Items, the rest to the inbox.
        let trashedOwn = try message(#"{"id":"m4","parentFolderId":"T","from":{"emailAddress":{"address":"me@contoso.com"}}}"#)
        let trashed = try message(#"{"id":"m5","parentFolderId":"TO","from":{"emailAddress":{"address":"ann@example.com"}}}"#)
        #expect(move(trashedOwn, [], ["TRASH"], false) == "S")
        #expect(move(trashed, [], ["TRASH"], false) == "I")
        // A category is a property, as are read state, flags and importance.
        #expect(move(received, ["category:Blue"], [], true) == nil)
        let patch = try #require(OutlookMail.patch(received, add: ["category:Blue", "STARRED"], remove: ["UNREAD", "category:Red"]))
        #expect(patch["categories"] as? [String] == ["Blue"])
        #expect(patch["isRead"] as? Bool == true)
        #expect((patch["flag"] as? [String: String])?["flagStatus"] == "flagged")
        #expect(OutlookMail.patch(sent, add: [], remove: ["UNREAD"]) == nil)
    }

    // ── Search ───────────────────────────────────────────────────────────────

    @Test func gmailOperatorsBecomeKQL() {
        let now = Date(timeIntervalSince1970: 1_791_504_000) // 2026-10-09
        let query = OutlookSearch.query(#"budget from:ann subject:"quarterly report" has:attachment is:unread in:inbox -label:red newer_than:7d"#, labels: box.labels, now: now)
        #expect(query.kql == #"budget from:ann subject:"quarterly report" hasattachments:true received>=2026-10-02"#)
        #expect(query.wanted == [
            .init(label: "UNREAD", negated: false),
            .init(label: "INBOX", negated: false),
            .init(label: "category:Red", negated: true),
        ])
        #expect(OutlookSearch.query("after:2026/01/15 -from:bob", labels: [], now: now).kql == "received>=2026-01-15 NOT from:bob")
        #expect(OutlookSearch.query("is:read in:projects/acme", labels: box.labels, now: now)
            == .init(kql: nil, wanted: [.init(label: "UNREAD", negated: true), .init(label: "folder:PA", negated: false)]))
        #expect(OutlookSearch.filter("STARRED") == "flag/flagStatus eq 'flagged'")
        #expect(OutlookSearch.filter("category:O'Brien") == "categories/any(c:c eq 'O''Brien')")
        #expect(OutlookSearch.filter("INBOX") == nil)
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    @Test func mimeSourceGivesBodiesInlineImagesFilesAndHeaders() {
        let source = [
            "From: Ann <ann@example.com>",
            "Message-ID: <m1@example.com>",
            "List-Unsubscribe: <mailto:leave@example.com>",
            "Content-Type: multipart/mixed; boundary=\"mix\"",
            "",
            "--mix",
            "Content-Type: multipart/related; boundary=\"rel\"",
            "",
            "--rel",
            "Content-Type: multipart/alternative; boundary=alt",
            "",
            "--alt",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: quoted-printable",
            "",
            "Caf=C3=A9 time",
            "--alt",
            "Content-Type: text/html; charset=\"utf-8\"",
            "",
            "<p>Café <img src=\"cid:logo@x\"></p>",
            "--alt--",
            "--rel",
            "Content-Type: image/png",
            "Content-ID: <logo@x>",
            "Content-Transfer-Encoding: base64",
            "",
            "iVBORw==",
            "--rel--",
            "--mix",
            "Content-Type: text/calendar; method=REQUEST",
            "",
            "BEGIN:VCALENDAR",
            "--mix",
            "Content-Type: application/pdf; name=\"report.pdf\"",
            "Content-Disposition: attachment; filename=\"report.pdf\"",
            "Content-Transfer-Encoding: base64",
            "",
            "JVBERi0=",
            "--mix--",
            "",
        ].joined(separator: "\r\n")
        let parsed = MIMEParser.parse(Data(source.utf8))
        #expect(parsed.text == "Café time")
        #expect(parsed.html == "<p>Café <img src=\"cid:logo@x\"></p>")
        #expect(parsed.files.count == 2)
        let content = OutlookMail.content(parsed)
        #expect(content.attachments.map(\.filename) == ["report.pdf"])
        #expect(content.attachments.first?.id == "mime:1")
        #expect(content.inline.map(\.contentID) == ["logo@x"])
        #expect(parsed.files[1].data == Data("%PDF-".utf8))
        #expect(content.headers["Message-ID"] == "<m1@example.com>")
        #expect(content.headers["List-Unsubscribe"] == "<mailto:leave@example.com>")
    }

    @Test func plainMessageWithoutMultipart() {
        let parsed = MIMEParser.parse(Data("Subject: Hi\nContent-Type: text/plain\n\nHello\nthere\n".utf8))
        #expect(parsed.text == "Hello\nthere\n")
        #expect(parsed.html == nil)
        #expect(parsed.files.isEmpty)
    }

    // ── Graph ────────────────────────────────────────────────────────────────

    private func graph(_ answer: @escaping @Sendable (URLRequest) async -> (Int, String, [String: String])) -> GraphAPI {
        GraphAPI(email: me, token: { _ in "token" }, transport: { request in
            let (status, body, headers) = await answer(request)
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
        })
    }

    @Test func pathsEncodeTheirQueries() {
        #expect(GraphAPI.path("/me/messages", [("$filter", "conversationId eq 'a=b+c'"), ("$top", "5")])
            == "/me/messages?$filter=conversationId%20eq%20'a%3Db%2Bc'&$top=5")
        #expect(GraphAPI.messagePath("AAk=/x") == "/me/messages/AAk%3D%2Fx")
    }

    @Test func deltaFollowsItsPagesToTheNextRoundsLink() async throws {
        let api = graph { request in
            #expect(request.value(forHTTPHeaderField: "Prefer")?.contains(#"IdType="ImmutableId""#) == true)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token")
            if request.url!.absoluteString.contains("page2") {
                return (200, #"{"value":[{"id":"b","@removed":{"reason":"deleted"}}],"@odata.deltaLink":"https://graph.microsoft.com/v1.0/next"}"#, [:])
            }
            return (200, #"{"value":[{"id":"a","conversationId":"c1","receivedDateTime":"2026-10-01T10:00:00Z"}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/page2"}"#, [:])
        }
        let delta = try await api.delta("https://graph.microsoft.com/v1.0/first")
        #expect(delta.changed.map(\.thread) == ["c1"])
        #expect(delta.removed == ["b"])
        #expect(delta.link == "https://graph.microsoft.com/v1.0/next")
    }

    @Test func anExpiredDeltaStartsOver() async {
        let api = graph { _ in (410, #"{"error":{"code":"SyncStateNotFound","message":"Gone"}}"#, [:]) }
        do {
            _ = try await api.delta("https://graph.microsoft.com/v1.0/old")
            Issue.record("An expired delta should throw.")
        } catch {
            #expect(GraphAPI.expired(error))
        }
    }

    @Test func throttledRequestsWaitAndRetry() async throws {
        let calls = Calls()
        let api = graph { _ in
            await calls.count() == 1 ? (429, "", ["Retry-After": "1"]) : (200, #"{"value":[]}"#, [:])
        }
        let page: GraphAPI.Page<GraphMessage> = try await api.get("/me/messages")
        #expect(page.value?.isEmpty == true)
        #expect(await calls.total == 2)
    }

    @Test func conversationsComeInBatches() async throws {
        let api = graph { request in
            #expect(request.url!.path().hasSuffix("/$batch"))
            let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            let requests = body["requests"] as! [[String: Any]]
            #expect((requests[0]["url"] as? String)?.contains("conversationId%20eq%20'c1'") == true)
            return (200, #"{"responses":[{"id":"0","status":200,"body":{"value":[{"id":"m1","conversationId":"c1"}]}},{"id":"1","status":404,"body":{}}]}"#, [:])
        }
        let found = try await api.conversations(["c1", "c2"])
        #expect(found["c1"]?.map(\.id) == ["m1"])
        #expect(found["c2"]?.isEmpty == true)
    }
}

private actor Calls {
    private(set) var total = 0
    func count() -> Int {
        total += 1
        return total
    }
}
