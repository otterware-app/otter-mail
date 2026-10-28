import Foundation
import Testing
@testable import Otter_Mail

/**
 * Archive as a folder of its own where Outlook and IMAP have one (`ARCHIVE`,
 * as contracts' landLabelChange lands it), Gmail's archive being All Mail;
 * which folders each mailbox shows; flags rather than stars.
 */
@MainActor
struct ArchiveTests {
    private let me = "me@contoso.com"

    private func thread(_ id: String, _ labels: Set<String>, mailbox: String = "me@contoso.com") -> MailThread {
        let message = Message(id: "\(id)-m", from: Person(name: "Ann", email: "ann@example.com"), to: [], cc: [], date: .now,
                              text: "", html: nil, attachments: [], unread: true, starred: false, draft: false, headers: [:])
        return MailThread(id: id, mailbox: mailbox, subject: id, labels: labels, messages: [message])
    }

    // ── Landing ──────────────────────────────────────────────────────────────

    @Test func archivingLandsInTheArchiveWhereItIsAFolder() {
        var inbox = thread("a", ["INBOX", "SENT", "UNREAD", "category:Red"])
        #expect(inbox.archivable(archiveFolder: true) == ["INBOX"])
        inbox.land(add: [], remove: ["INBOX"], archiveFolder: true)
        // Your reply stays in Sent; categories and flags stay on.
        #expect(inbox.labels == ["SENT", "UNREAD", "category:Red", "ARCHIVE"])

        var filed = thread("b", ["folder:X", "INBOX"])
        #expect(filed.archivable(archiveFolder: true) == ["folder:X", "INBOX"])
        filed.land(add: [], remove: ["folder:X"], archiveFolder: true)
        #expect(filed.labels == ["INBOX", "ARCHIVE"])

        // Back to the inbox, out of the Archive and the folders; into a folder likewise.
        var archived = thread("c", ["ARCHIVE", "folder:X", "SENT"])
        archived.land(add: ["INBOX"], remove: ["SPAM", "TRASH"], archiveFolder: true)
        #expect(archived.labels == ["INBOX", "SENT"])
        archived.land(add: ["folder:Y"], remove: [], archiveFolder: true)
        #expect(archived.labels == ["folder:Y", "SENT"])

        // A category or a flag isn't a folder.
        var tagged = thread("d", ["INBOX", "category:Red"])
        tagged.land(add: ["STARRED"], remove: ["category:Red"], archiveFolder: true)
        #expect(tagged.labels == ["INBOX", "STARRED"])
    }

    @Test func gmailArchivesByTakingTheInboxAway() {
        var gmail = thread("a", ["INBOX", "Label_1"])
        #expect(gmail.archivable(archiveFolder: false) == ["INBOX"])
        gmail.land(add: [], remove: ["INBOX"], archiveFolder: false)
        #expect(gmail.labels == ["Label_1"])
        #expect(gmail.archivable(archiveFolder: false).isEmpty)
    }

    @Test func archiveAndUndoFromAFolder() {
        let outlook = Mailbox(email: me, name: "Me", displayName: "Contoso", color: "#0078d4", signature: "", labels: [],
                              hasArchive: true, outlook: true)
        let gmail = Mailbox(email: "me@gmail.com", name: "Me", displayName: "Personal", color: "#336699", signature: "", labels: [])
        let filed = thread("filed", ["folder:X"]), labeled = thread("labeled", ["Label_1"], mailbox: gmail.email)
        let store = MailStore(preferences: Preferences(), mailboxes: [outlook, gmail], threads: [filed, labeled])
        // Gmail archives only out of the inbox; Outlook out of a folder too.
        #expect(!store.canArchive(labeled))
        #expect(store.canArchive(filed))
        store.archive(filed.id)
        #expect(store.threads(in: .label(id: "folder:X", name: "X"), scope: me).isEmpty)
        #expect(store.threads(in: .archive, scope: me).map(\.id) == [filed.id])
        #expect(!store.canArchive(store.thread(filed.id)!))
        store.undo()
        #expect(store.thread(filed.id)?.labels == ["folder:X"])
        // In the Archive, back to the inbox.
        store.archive(filed.id)
        store.commitPendingAction()
        store.moveToInbox(filed.id)
        #expect(store.threads(in: .inbox, scope: me).map(\.id) == [filed.id])
        #expect(store.threads(in: .archive, scope: me).isEmpty)
    }

    // ── What each mailbox shows ──────────────────────────────────────────────

    @Test func foldersAndMarksFollowTheProvider() {
        let gmail = Mailbox(email: "me@gmail.com", name: "", displayName: "", color: "", signature: "", labels: [])
        var outlook = gmail
        outlook.outlook = true
        var imap = gmail
        imap.imap = ImapSettings(username: "me", imap: MailServer(host: "imap.example.com", port: 993, security: .tls),
                                 smtp: MailServer(host: "smtp.example.com", port: 465, security: .tls))
        #expect(gmail.folders == [.inbox, .starred, .sent, .drafts, .important, .allMail, .junk, .trash])
        #expect(imap.folders == [.inbox, .starred, .sent, .drafts, .junk, .trash])
        outlook.hasArchive = true
        #expect(outlook.folders == [.inbox, .starred, .sent, .drafts, .archive, .junk, .trash])
        #expect(Folder.starred.title(in: gmail) == "Starred" && gmail.mark == "star")
        #expect(Folder.starred.title(in: outlook) == "Flagged" && Folder.starred.symbol(in: imap) == "flag" && imap.mark == "flag")
        // The page's key stays put whatever it's called.
        #expect(MailSync.key(.starred) == "Starred")
    }

    @Test func arrangementsFromBeforeIgnoreCombined() throws {
        let json = #"{"order":["b@example.com","a@example.com"],"off":["c@example.com"],"combined":false}"#
        let arrangement = try JSONDecoder().decode(Preferences.Arrangement.self, from: Data(json.utf8))
        #expect(arrangement.order == ["b@example.com", "a@example.com"])
        #expect(arrangement.off == ["c@example.com"])
        let written = String(decoding: try JSONEncoder().encode(arrangement), as: UTF8.self)
        #expect(!written.contains("combined"))
    }

    // ── Outlook ──────────────────────────────────────────────────────────────

    private var box: OutlookFolders {
        OutlookFolders(
            wellKnown: ["inbox": "I", "sentitems": "S", "drafts": "D", "deleteditems": "T", "junkemail": "J", "archive": "A"],
            children: [nil: [
                .init(id: "I", displayName: "Inbox", childFolderCount: 0), .init(id: "S", displayName: "Sent Items", childFolderCount: 0),
                .init(id: "A", displayName: "Archive", childFolderCount: 0), .init(id: "P", displayName: "Projects", childFolderCount: 0),
            ]],
            categories: []
        )
    }

    private func message(_ json: String) throws -> GraphMessage {
        try JSONDecoder().decode(GraphMessage.self, from: Data(json.utf8))
    }

    @Test func outlooksArchiveIsAFolderToMoveInAndOutOf() throws {
        let box = self.box
        #expect(box.label(ofFolder: "A") == "ARCHIVE")
        #expect(box.folder(ofLabel: "ARCHIVE") == "A")
        #expect(box.hasArchive)
        #expect(!box.labels.contains { $0.id == "ARCHIVE" })
        let move = { (message: GraphMessage, add: [String], remove: [String]) in
            OutlookMail.destination(message, add: add, remove: remove, wholeThread: true, mailbox: self.me, folders: box)
        }
        let received = try message(#"{"id":"m1","parentFolderId":"I","from":{"emailAddress":{"address":"ann@example.com"}}}"#)
        let filed = try message(#"{"id":"m2","parentFolderId":"P","from":{"emailAddress":{"address":"ann@example.com"}}}"#)
        let archived = try message(#"{"id":"m3","parentFolderId":"A","from":{"emailAddress":{"address":"ann@example.com"}}}"#)
        let archivedOwn = try message(#"{"id":"m4","parentFolderId":"A","from":{"emailAddress":{"address":"me@contoso.com"}}}"#)
        let sent = try message(#"{"id":"m5","parentFolderId":"S","from":{"emailAddress":{"address":"me@contoso.com"}}}"#)
        // Archived from the inbox or a folder; your sent mail stays.
        #expect(move(received, [], ["INBOX"]) == "A")
        #expect(move(filed, [], ["folder:P"]) == "A")
        #expect(move(sent, [], ["INBOX", "folder:P"]) == nil)
        // ARCHIVE is a place to move to; taken away, mail goes back (yours to Sent Items).
        #expect(move(received, ["ARCHIVE"], ["INBOX"]) == "A")
        #expect(move(archived, [], ["ARCHIVE"]) == "I")
        #expect(OutlookMail.destination(archivedOwn, add: [], remove: ["ARCHIVE"], wholeThread: false, mailbox: me, folders: box) == "S")
        #expect(move(archived, ["INBOX"], ["SPAM"]) == "I")
        // Searching in:archive is searching the folder.
        #expect(OutlookSearch.query("in:archive budget", labels: box.labels).wanted == [.init(label: "ARCHIVE", negated: false)])
    }

    @Test func outlookLabelsArchiveMailCachedBeforeOnce() async throws {
        let api = GraphAPI(email: me, token: { _ in "token" }, transport: { request in
            let url = request.url!.absoluteString.removingPercentEncoding!
            let body: String
            if url.hasSuffix("/$batch") {
                let requests = (try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any])["requests"] as! [[String: Any]]
                body = #"{"responses":["# + requests.map { entry in
                    let (id, url) = (entry["id"] as! String, entry["url"] as! String)
                    let folder = ["inbox": "I", "sentitems": "S", "drafts": "D", "archive": "A"].first { url.hasPrefix("/me/mailFolders/\($0.key)?") }
                    let answer = if let folder { #"{"id":"\#(folder.value)"}"# }
                        else if url.contains("conversationId") {
                            #"{"value":[{"id":"m1","conversationId":"c1","parentFolderId":"A","isRead":true,"receivedDateTime":"2026-10-01T10:00:00Z","from":{"emailAddress":{"address":"ann@example.com"}}}]}"#
                        } else { "{}" }
                    return #"{"id":"\#(id)","status":\#(answer == "{}" ? 404 : 200),"body":\#(answer)}"#
                }.joined(separator: ",") + "]}"
            } else if url.contains("/mailFolders/A/messages") {
                #expect(url.contains("$select=id,conversationId"))
                body = #"{"value":[{"id":"m1","conversationId":"c1"},{"id":"m9","conversationId":"not-here"}]}"#
            } else if url.contains("/me/mailFolders?") {
                body = #"{"value":[{"id":"I","displayName":"Inbox"},{"id":"S","displayName":"Sent Items"},{"id":"D","displayName":"Drafts"},{"id":"A","displayName":"Archive"}]}"#
            } else {
                body = #"{"value":[]}"#
            }
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let provider = OutlookProvider(email: me, api: api, watchTarget: nil)
        // As an older version left it: archived mail without a label.
        var cached = thread("c1", [])
        cached.messages[0].id = "m1"
        var state = MailboxState()
        state.deltas = [:]
        let delta = try await provider.sync(&state, known: [cached])
        #expect(delta.threads.map(\.labels) == [["ARCHIVE"]])
        #expect(state.archiveLabeled == true)
        #expect(provider.hasArchive)
        // Once.
        #expect(try await provider.sync(&state, known: delta.threads).threads.isEmpty)
    }

    // ── IMAP ─────────────────────────────────────────────────────────────────

    private func folder(_ path: String, _ attributes: Set<String> = [], delimiter: String = "/") -> ImapFolder {
        ImapFolder(path: path, delimiter: delimiter, attributes: attributes)
    }

    @Test func imapsArchiveIsFlaggedOrNamedNeverAll() {
        // The folder flagged \Archive wins; one named Archive is just a folder then.
        let flagged = ImapProvider.folders([folder("INBOX"), folder("Archive"), folder("Kept", ["\\archive"])], gmail: false)
        #expect(flagged.roles[.archive] == "Kept")
        #expect(ImapProvider.folders([folder("INBOX"), folder("Archiv")], gmail: false).roles[.archive] == "Archiv")
        #expect(ImapProvider.folders([folder("INBOX"), folder("INBOX.Archives", delimiter: ".")], gmail: false).roles[.archive] == "INBOX.Archives")
        // Only at the top or right under INBOX.
        #expect(ImapProvider.folders([folder("INBOX"), folder("Clients/Archive")], gmail: false).roles[.archive] == nil)
        // A server's virtual All (Dovecot) holds copies: neither the archive nor a folder to sync.
        let dovecot = ImapProvider.folders([folder("INBOX"), folder("All", ["\\all"]), folder("Flagged", ["\\flagged"])], gmail: false)
        #expect(dovecot.roles[.archive] == nil)
        #expect(dovecot.folders.map(\.path) == ["INBOX"])
        #expect(dovecot.allMail == nil)
    }

    @Test func gmailsImapArchivesIntoAllMail() {
        let gmail = ImapProvider.folders([
            folder("INBOX"), folder("[Gmail]/All Mail", ["\\all"]), folder("[Gmail]/Sent Mail", ["\\sent"]), folder("Archive"),
        ], gmail: true)
        #expect(gmail.allMail == "[Gmail]/All Mail")
        // A Gmail label named Archive is just a label; All Mail isn't synced.
        #expect(gmail.roles[.archive] == nil)
        #expect(gmail.folders.map(\.path) == ["INBOX", "[Gmail]/Sent Mail", "Archive"])
        #expect(gmail.roles[.sent] == "[Gmail]/Sent Mail")
    }
}
