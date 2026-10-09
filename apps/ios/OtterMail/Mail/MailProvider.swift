import Foundation

/**
 * Where a mailbox's mail comes from, as core's providers/provider.ts: Gmail's
 * API (`Gmail/`), an IMAP server with SMTP to send (`Imap/`), or Outlook
 * through Microsoft Graph (`Outlook/`). MailSync
 * drives it and keeps the copy; above it everything sees threads carrying
 * labels, and the UI asks `capabilities` what a mailbox can do.
 *
 * Calls that change the mailbox answer what changed as a `MailDelta` (Gmail
 * mostly answers nothing: the store already shows it). `state` is the
 * provider's cursor, saved with the mailbox's threads.
 */
protocol MailProvider: AnyObject {
    var capabilities: MailCapabilities { get }
    /**
     * Calls on a mailbox must run one at a time: they rewrite the copy (IMAP
     * moves change message ids), so each has to start from what the last left.
     */
    var takesTurns: Bool { get }

    /** Catches `state` up with the server (from scratch when it's empty). `known` is this mailbox's copy. */
    func sync(_ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta
    /** The folder's next page (its first, the first time); `state.pages` says whether there's more. */
    func loadMore(_ folder: Folder, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta
    /** The server's search: the matching thread ids, and those threads not already `known`. */
    func search(_ query: String, known: [MailThread]) async throws -> (ids: [String], threads: [MailThread])
    /** The mailbox's own labels (IMAP: its folders). */
    func labels() async throws -> [MailLabel]
    /** The signature the server keeps; nil when the app keeps it (following the Otter account). */
    func signature() async throws -> String?
    /** Saves the signature; answers it as kept. */
    func setSignature(_ html: String) async throws -> String

    /** Writes a change the store already shows. */
    func apply(_ change: MailStore.Change, to thread: MailThread, _ state: inout MailboxState) async throws -> MailDelta
    /** The thread as the server has it (after a change it refused). */
    func refresh(_ thread: MailThread, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta
    /** Sends the message (replacing the draft it was, if any); answers its thread. */
    func send(_ message: Outgoing, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta
    /** Keeps the message in Drafts (replacing its previous version); answers its thread. */
    func saveDraft(_ message: Outgoing, _ state: inout MailboxState, known: [MailThread]) async throws -> MailDelta
    func deleteDraft(_ messageID: String, _ state: inout MailboxState) async throws
    func attachment(_ attachment: Attachment, of message: Message) async throws -> Data

    /**
     * Keeps new mail coming while the app is open: Gmail asks to push through
     * the relay (`pushTopic`, renewed daily; the relay's events then sync),
     * Outlook keeps a Graph subscription pointed at the relay, an IMAP server
     * is watched with IDLE, calling `onChange`. Answers what to cancel when
     * the app goes to the background, if anything runs here.
     */
    func watch(pushTopic: String?, _ state: inout MailboxState, onChange: @escaping () -> Void) async -> Task<Void, Never>?
}

/** What a provider found or did: threads to show (whole), and threads gone. */
nonisolated struct MailDelta {
    var threads: [MailThread] = []
    var removed: Set<String> = []
}

/** A message to send or keep in Drafts, as RFC 5322 (MIME.message) with its envelope. */
nonisolated struct Outgoing {
    var raw: Data
    var from: String
    var recipients: [String]
    /** The thread it replies in. */
    var threadID: String?
    /** The draft message it replaces. */
    var draft: String?

    // The same message as the composer has it, for Outlook, which writes it through Graph rather than as MIME.
    var subject = ""
    var html = ""
    var to: [Person] = []
    var cc: [Person] = []
    var bcc: [Person] = []
    var files: [MIME.File] = []
    /** The message it answers (Outlook makes the reply from it, so it stays in the conversation). */
    var replyTo: String? = nil
}

/** What's kept per mailbox besides its threads: the provider's cursors, and where each folder's list got to. */
nonisolated struct MailboxState: Codable {
    /** Gmail's history cursor. */
    var historyID: String?
    /** Gmail's draft ids, by draft message id. */
    var draftIDs: [String: String] = [:]
    /** Folder key → the next page's token; "" once the folder has no more. */
    var pages: [String: String] = [:]
    var watchedAt: Date?
    var watchExpiresAt: Date?
    var watchTopic: String?
    /** IMAP: each synced folder's cursor, by path. */
    var folders: [String: ImapFolderState]? = nil
    /** IMAP: where trashed mail came from (its id in Trash → folder path), for Restore. */
    var trashedFrom: [String: String]? = nil
    /** Folder key → the oldest date its pages reached: its list stops there, so the next page adds to the bottom. */
    var reached: [String: Date]? = nil
    /** Outlook: each followed folder's delta link, by folder id. */
    var deltas: [String: String]? = nil
    /** Outlook: this iPhone's Graph subscription, which sends the mailbox's changes to the relay (`watchTopic`: where). */
    var subscription: String? = nil

    /** A folder's page came in, back to `oldest`; `next` is the page after it, nil at the end. */
    mutating func paged(_ key: String, next: String?, oldest: Date?) {
        pages[key] = next ?? ""
        guard let oldest else { return }
        reached = (reached ?? [:]).merging([key: oldest], uniquingKeysWith: min)
    }

    /**
     * Whether the folder's list goes down to `thread`. Mail cached from other
     * folders can be older than the pages loaded here, and a page would land
     * above it; so until every page is in, the list ends where they reached.
     */
    func lists(_ thread: MailThread, in key: String) -> Bool {
        guard pages[key] != "", let reached = reached?[key] else { return true }
        return thread.latest.date >= reached
    }

    /** The folder has more, and no page yet says where its list ends (every cached thread shows). */
    func unbounded(_ key: String) -> Bool {
        pages[key] != "" && reached?[key] == nil
    }
}

/** Where an IMAP folder's copy got to (RFC 3501, CONDSTORE). */
nonisolated struct ImapFolderState: Codable, Equatable {
    var uidValidity: UInt32
    var uidNext: UInt32
    var highestModSeq: UInt64?
    /** The oldest UID loaded (pages go back from it). */
    var oldest: UInt32
}
