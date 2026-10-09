import Foundation

/** Graph's message resource, with the fields Otter Mail asks for (core's outlook/messages.ts). */
nonisolated struct GraphMessage: Decodable {
    struct Recipient: Decodable {
        struct Address: Decodable { var name: String?; var address: String? }
        var emailAddress: Address?
    }
    struct Flag: Decodable { var flagStatus: String? }
    struct Body: Decodable { var contentType: String?; var content: String? }
    struct Header: Decodable { var name: String; var value: String }
    /** Delta's mark on a message gone from the folder. */
    struct Removed: Decodable { var reason: String? }

    var id: String
    var conversationId: String?
    var subject: String?
    var bodyPreview: String?
    var from: Recipient?
    var sender: Recipient?
    var toRecipients: [Recipient]?
    var ccRecipients: [Recipient]?
    var bccRecipients: [Recipient]?
    var receivedDateTime: String?
    var sentDateTime: String?
    var isRead: Bool?
    var isDraft: Bool?
    var flag: Flag?
    var importance: String?
    var categories: [String]?
    var hasAttachments: Bool?
    var parentFolderId: String?
    var internetMessageId: String?
    var body: Body?
    var internetMessageHeaders: [Header]?
    var removed: Removed?

    enum CodingKeys: String, CodingKey {
        case id, conversationId, subject, bodyPreview, from, sender, toRecipients, ccRecipients, bccRecipients
        case receivedDateTime, sentDateTime, isRead, isDraft, flag, importance, categories, hasAttachments
        case parentFolderId, internetMessageId, body, internetMessageHeaders
        case removed = "@removed"
    }

    /** What a thread needs of each message (its words come from the MIME source). */
    static let fields = "id,conversationId,subject,bodyPreview,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isRead,isDraft,flag,importance,categories,hasAttachments,parentFolderId,internetMessageId"

    /** Its thread: Outlook's conversation. */
    var thread: String { conversationId ?? id }
    var flagged: Bool { flag?.flagStatus == "flagged" }

    /** Drafts and sent mail are dated when written; received mail when it arrived. */
    var date: Date {
        let text = isDraft == true ? sentDateTime ?? receivedDateTime : receivedDateTime
        return text.flatMap { try? Date($0, strategy: .iso8601) } ?? .distantPast
    }
}

/** An attachment as Graph lists it (without its bytes). */
nonisolated struct GraphAttachment: Decodable {
    var id: String
    var name: String?
    var contentType: String?
    var size: Int?
    var isInline: Bool?
}

/** A message's words, files and headers: what the list's properties don't carry. */
nonisolated struct OutlookContent {
    var text: String
    var html: String?
    var attachments: [Attachment]
    var inline: [Attachment]
    var headers: [String: String]
}

/** Outlook's messages in the app's shape, and label changes as Graph writes them. */
nonisolated enum OutlookMail {
    /** From the MIME source; attachment ids are `mime:<index>` into its files, as core's are. */
    static func content(_ parsed: MIMEParser.Parsed) -> OutlookContent {
        let files = Array(parsed.files.enumerated())
        let attachment = { (item: (offset: Int, element: MIMEParser.File)) in
            Attachment(id: "mime:\(item.offset)", filename: item.element.filename, mimeType: item.element.mimeType,
                       size: item.element.data.count, contentID: item.element.inline ? item.element.contentID : nil)
        }
        var headers: [String: String] = [:]
        for name in ["Message-ID", "References", "List-Unsubscribe", "List-Unsubscribe-Post", "Bcc"] {
            if let value = MailDecoding.header(name, in: parsed.headers) { headers[name] = value }
        }
        return OutlookContent(
            text: parsed.text ?? parsed.html.map(HTMLText.plain) ?? "",
            html: parsed.html,
            attachments: files.filter { !$0.element.inline }.map(attachment),
            inline: files.filter(\.element.inline).map(attachment),
            headers: headers
        )
    }

    /** From Graph's properties (a message with big attachments); files are `graph:<attachment id>`, fetched when opened. */
    static func content(_ message: GraphMessage, attachments: [GraphAttachment]) -> OutlookContent {
        let html = message.body?.contentType?.lowercased() == "html" ? message.body?.content : nil
        var headers: [String: String] = [:]
        if let id = message.internetMessageId { headers["Message-ID"] = id }
        for name in ["References", "List-Unsubscribe", "List-Unsubscribe-Post"] {
            if let value = message.internetMessageHeaders?.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame })?.value {
                headers[name] = value
            }
        }
        return OutlookContent(
            text: html.map(HTMLText.plain) ?? message.body?.content ?? "",
            html: html,
            attachments: attachments.filter { $0.isInline != true }.map {
                Attachment(id: "graph:\($0.id)", filename: $0.name ?? "", mimeType: $0.contentType ?? "application/octet-stream", size: $0.size ?? 0)
            },
            inline: [],
            headers: headers
        )
    }

    /** What's here already of a message (its words don't change once it's sent). */
    static func content(keeping message: Message) -> OutlookContent {
        OutlookContent(text: message.text, html: message.html, attachments: message.attachments, inline: message.inline ?? [], headers: message.headers)
    }

    static func message(_ message: GraphMessage, mailbox: String, content: OutlookContent?) -> Message {
        let people = { (list: [GraphMessage.Recipient]?) in
            (list ?? []).compactMap(\.emailAddress).compactMap { address in
                address.address.map { Person(name: address.name == $0 ? "" : address.name ?? "", email: $0) }
            }
        }
        let from = (message.from ?? message.sender)?.emailAddress
        let address = from?.address ?? ""
        // Your own mail can name you by Exchange's internal address (/O=…/CN=…) for a while.
        let email = address.contains("@") ? address : message.isDraft == true || !address.isEmpty ? mailbox : ""
        var headers = content?.headers ?? [:]
        if headers["Message-ID"] == nil, let id = message.internetMessageId { headers["Message-ID"] = id }
        let bcc = people(message.bccRecipients)
        if !bcc.isEmpty { headers["Bcc"] = bcc.map(Draft.format).joined(separator: ", ") }
        return Message(
            id: message.id,
            from: Person(name: from?.name == address ? "" : from?.name ?? "", email: email),
            to: people(message.toRecipients),
            cc: people(message.ccRecipients),
            date: message.date,
            text: content?.text ?? message.bodyPreview ?? "",
            html: content?.html,
            attachments: content?.attachments ?? [],
            inline: content.flatMap { $0.inline.isEmpty ? nil : $0.inline },
            unread: message.isRead == false,
            starred: message.flagged,
            draft: message.isDraft == true,
            headers: headers
        )
    }

    /**
     * A conversation as a thread: its messages in synced folders, oldest
     * first, wearing their folders', categories' and importance's labels
     * (read state, flags and drafts are the messages' own, as for Gmail).
     */
    static func thread(
        _ id: String, _ messages: [GraphMessage], mailbox: String, folders: OutlookFolders,
        contents: [String: OutlookContent], known: [String: Message]
    ) -> MailThread? {
        let shown = messages.filter { folders.isSynced($0.parentFolderId) }.sorted { $0.date < $1.date }
        guard let first = shown.first else { return nil }
        var labels = Set(shown.flatMap { folders.labels(of: $0) })
        labels.subtract(["UNREAD", "STARRED", "DRAFT"])
        let subject = first.subject ?? ""
        return MailThread(
            id: id,
            mailbox: mailbox,
            subject: subject.isEmpty ? "(no subject)" : subject,
            labels: labels,
            messages: shown.map { message($0, mailbox: mailbox, content: contents[$0.id] ?? known[$0.id].map(content(keeping:))) }
        )
    }

    // ── Changing ─────────────────────────────────────────────────────────────

    /** The property changes a label change makes to a message (nil: none). */
    static func patch(_ message: GraphMessage, add: [String], remove: [String]) -> [String: Any]? {
        var patch: [String: Any] = [:]
        if add.contains("UNREAD"), message.isRead != false { patch["isRead"] = false }
        if remove.contains("UNREAD"), message.isRead == false { patch["isRead"] = true }
        if add.contains("STARRED"), !message.flagged { patch["flag"] = ["flagStatus": "flagged"] }
        if remove.contains("STARRED"), message.flagged { patch["flag"] = ["flagStatus": "notFlagged"] }
        if add.contains("IMPORTANT"), message.importance != "high" { patch["importance"] = "high" }
        if remove.contains("IMPORTANT"), message.importance == "high" { patch["importance"] = "normal" }
        var categories = message.categories ?? []
        for name in add.compactMap(OutlookFolders.category) where !categories.contains(name) { categories.append(name) }
        categories.removeAll { remove.compactMap(OutlookFolders.category).contains($0) }
        if categories != (message.categories ?? []) { patch["categories"] = categories }
        return patch.isEmpty ? nil : patch
    }

    /**
     * Where a label change sends a message (nil: it stays), as core's
     * outlook/writes.ts: into an added folder label's folder; out of the inbox
     * or a folder, to the Archive; out of Junk or Deleted Items, back to the
     * inbox (Sent Items for your own). On a thread, your sent mail and drafts
     * stay put unless it's trashed.
     */
    static func destination(_ message: GraphMessage, add: [String], remove: [String], wholeThread: Bool, mailbox: String, folders: OutlookFolders) -> String? {
        let current = folders.label(ofFolder: message.parentFolderId)
        let own = current == "SENT" || current == "DRAFT" || message.isDraft == true
            || message.from?.emailAddress?.address?.lowercased() == mailbox.lowercased()
        let target = add.first { $0 == "TRASH" } ?? add.first { $0 == "SPAM" }
            ?? add.first { $0.hasPrefix(OutlookFolders.folderPrefix) } ?? add.first { $0 == "INBOX" }
        if let target {
            if target == current { return nil }
            if wholeThread, own, target != "TRASH" { return nil }
            // Back to the inbox: only what's archived (or junk, or trash), not mail in other folders.
            if target == "INBOX", wholeThread, current?.hasPrefix(OutlookFolders.folderPrefix) == true { return nil }
            return folders.folder(ofLabel: target)
        }
        guard let current, remove.contains(current) else { return nil }
        if current == "SPAM" || current == "TRASH" { return folders.id(own ? "sentitems" : "inbox") }
        if current == "INBOX" || current.hasPrefix(OutlookFolders.folderPrefix) { return folders.id("archive") }
        return nil
    }

    /** The composer's message as Graph's fields. */
    static func fields(_ message: Outgoing) -> [String: Any] {
        let recipients = { (people: [Person]) in
            people.map { person -> [String: Any] in
                ["emailAddress": person.name.isEmpty ? ["address": person.email] : ["address": person.email, "name": person.name]]
            }
        }
        return [
            "subject": message.subject,
            "body": ["contentType": "html", "content": message.html],
            "toRecipients": recipients(message.to),
            "ccRecipients": recipients(message.cc),
            "bccRecipients": recipients(message.bcc),
        ]
    }
}

extension OutlookFolders {
    nonisolated func labels(of message: GraphMessage) -> [String] {
        labels(folder: message.parentFolderId, isRead: message.isRead, flagged: message.flagged, importance: message.importance, categories: message.categories)
    }
}
