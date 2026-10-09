import Foundation

/**
 * The mail the app shows, shaped like Gmail's: mailboxes (the Gmail, IMAP and
 * Outlook accounts on the Otter account), their labels, and threads of
 * messages. Label ids are Gmail's (`INBOX`, `STARRED`, …) or a user label's;
 * an IMAP folder is a label (docs/imap.md), and so are Outlook's folders and
 * categories (docs/outlook.md).
 */

nonisolated struct Person: Hashable, Codable {
    var name: String
    var email: String

    /** The name, or the address when there's none. */
    var label: String { name.isEmpty ? email : name }

    /** Whether this is `address` (a mailbox's own, say), whatever its case. */
    func isAddress(_ address: String) -> Bool { email.caseInsensitiveCompare(address) == .orderedSame }
}

nonisolated struct Mailbox: Identifiable, Hashable, Codable {
    /** The address: the one thing every device agrees on. */
    var email: String
    var name: String
    /** Set in Settings › Mailboxes; shown in the sidebar and on rows. */
    var displayName: String
    var color: String
    /** The address's signature, as HTML: Gmail's, or for IMAP and Outlook the Otter account's (preferences, `signatures`). */
    var signature: String
    var labels: [MailLabel]
    var picture: String? = nil
    /** Linked to the Otter account on another device, but not signed in on this one (Google, Microsoft, or the IMAP password). */
    var signedOut = false
    /** Where an IMAP mailbox lives; nil for Gmail and Outlook. */
    var imap: ImapSettings? = nil
    /** An Outlook mailbox (Microsoft Graph). */
    var outlook: Bool? = nil

    var id: String { email }
    var me: Person { Person(name: name, email: email) }
    var provider: MailProviderKind { imap != nil ? .imap : outlook == true ? .outlook : .gmail }
    var capabilities: MailCapabilities {
        switch provider {
        case .gmail: .gmail
        case .imap: .imap
        case .outlook: .outlook
        }
    }
}

// ── Providers (packages/contracts/src/mail.ts) ────────────────────────────

nonisolated enum MailProviderKind: String, Codable {
    case gmail, imap, outlook
}


/** What a mailbox can do beyond reading, organizing and sending; the UI hides the rest. */
nonisolated struct MailCapabilities: Hashable {
    /** Gmail's sorting of the inbox (categories, Important). */
    var categories: Bool
    /** A message can carry several labels at once (Gmail, Outlook's categories); IMAP mail sits in one folder. */
    var multipleLabels: Bool
    var labelColors: Bool
    /** Signatures kept by the server (Gmail's settings) rather than on this iPhone. */
    var serverSignatures: Bool
    var calendar: Bool
    /** New mail arrives by push through the relay (Gmail, Outlook); otherwise the iPhone watches itself. */
    var relayPush: Bool

    static let gmail = MailCapabilities(categories: true, multipleLabels: true, labelColors: true, serverSignatures: true, calendar: true, relayPush: true)
    static let imap = MailCapabilities(categories: false, multipleLabels: false, labelColors: false, serverSignatures: false, calendar: false, relayPush: false)
    /** Categories are its labels (colored), folders move mail; Graph doesn't expose Outlook's signatures. */
    static let outlook = MailCapabilities(categories: false, multipleLabels: true, labelColors: true, serverSignatures: false, calendar: false, relayPush: true)
}

nonisolated struct MailLabel: Identifiable, Hashable, Codable {
    /** Gmail's label id ("Label_12"); the demo uses the name. */
    var id: String
    /** Gmail nests labels by "/" in the name. */
    var name: String
    var color: String?

    var leaf: String { name.split(separator: "/").last.map(String.init) ?? name }
    var depth: Int { name.split(separator: "/").count - 1 }
}

nonisolated struct Attachment: Hashable, Codable {
    /** Gmail's attachment id, to download it; nil in the demo. */
    var id: String? = nil
    var filename: String
    var mimeType: String
    var size: Int
    /** Set on an image the HTML shows inline (`cid:` + this), rather than a file. */
    var contentID: String? = nil
}

nonisolated struct Message: Identifiable, Hashable, Codable {
    var id: String
    var from: Person
    var to: [Person]
    var cc: [Person]
    var date: Date
    var text: String
    var html: String?
    var attachments: [Attachment]
    /** Images the HTML shows inline (by `contentID`). */
    var inline: [Attachment]? = nil
    var unread: Bool
    var starred: Bool
    var draft: Bool
    /** The ones replies and unsubscribing need: Message-ID, References, List-Unsubscribe. */
    var headers: [String: String]

    /** The message's own words (not the history it quotes), whitespace collapsed, as Gmail's snippet. */
    var snippet: String {
        // A one-line preview must not scan megabytes of newsletter or quoted history while scrolling.
        let body = Quote.split(String(text.prefix(4096))).body
        return MailDecoding.preview(body.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix(">") }
            .joined(separator: " "))
    }
}

nonisolated struct MailThread: Identifiable, Hashable, Codable {
    var id: String
    var mailbox: String
    var subject: String
    var labels: Set<String>
    var messages: [Message]

    var latest: Message { messages.last! }
    var unread: Bool { messages.contains(where: \.unread) }
    var starred: Bool { messages.contains(where: \.starred) }
    var hasAttachments: Bool { messages.contains { !$0.attachments.isEmpty } }
    var isDraft: Bool { messages.allSatisfy(\.draft) }
    var sent: [Message] { messages.filter { !$0.draft } }
}

/** The system folders of the sidebar, then the mailbox's labels (views-store.ts's built-ins). */
nonisolated enum Folder: Hashable {
    case inbox, starred, sent, drafts, important, allMail, junk, trash
    case label(id: String, name: String)

    static let system: [Folder] = [.inbox, .starred, .sent, .drafts, .important, .allMail, .junk, .trash]

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .starred: "Starred"
        case .sent: "Sent"
        case .drafts: "Drafts"
        case .important: "Important"
        case .allMail: "All Mail"
        case .junk: "Junk"
        case .trash: "Trash"
        case .label(_, let name): name.split(separator: "/").last.map(String.init) ?? name
        }
    }

    var symbol: String {
        switch self {
        case .inbox: "tray"
        case .starred: "star"
        case .sent: "paperplane"
        case .drafts: "doc"
        case .important: "flag"
        case .allMail: "archivebox"
        case .junk: "xmark.bin"
        case .trash: "trash"
        case .label: "tag"
        }
    }
}

/** A reply's own words, and the history it quotes ("On … wrote:" and the ">" lines after). */
nonisolated enum Quote {
    static func split(_ text: String) -> (body: String, quote: String?) {
        let pattern = /\n+(On .{4,200}wrote:\s*\n|>)/
        guard let match = text.firstMatch(of: pattern), text[match.range.upperBound...].contains(">") || match.output.1 == ">" else {
            return (text, nil)
        }
        let body = String(text[..<match.range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? (text, nil) : (body, String(text[match.range.lowerBound...]))
    }
}
