import Foundation

/**
 * An Outlook mailbox's folders and categories as labels, with the label ids
 * core's outlook/folders.ts gives them (docs/outlook.md), so views, projects
 * and preferences mean the same on every device:
 *
 * - Inbox → `INBOX`, Sent Items → `SENT`, Drafts → `DRAFT`, Deleted Items →
 *   `TRASH`, Junk Email → `SPAM` (folders inside the last two count as them),
 *   Archive → no label (archived mail just lacks `INBOX`). Outbox,
 *   Conversation History, Sync Issues and Scheduled aren't synced.
 * - Every other folder is a user label `folder:<id>`, named by its path. A
 *   message sits in one folder: applying a folder's label moves it there.
 * - Categories are user labels `category:<name>`, several per message, in
 *   Outlook's preset colors.
 * - Flagged → `STARRED`, unread → `UNREAD`, high importance → `IMPORTANT`.
 */
nonisolated struct OutlookFolders: Equatable {
    struct Folder: Equatable {
        var id: String
        /** Its path, "/" between levels. */
        var name: String
        var parentID: String?
        /** The label its mail carries: a system label, `folder:<id>`, or none (the archive). */
        var label: String?
    }

    struct Category: Equatable {
        var name: String
        /** Outlook's preset ("preset0" … "preset24"), or "none". */
        var color: String
    }

    /** Graph's well-known folder names → their ids. */
    var wellKnown: [String: String]
    /** Folders worth syncing, the inbox first and Junk and Deleted Items last. */
    var folders: [Folder]
    var categories: [Category]

    static let folderPrefix = "folder:"
    static let categoryPrefix = "category:"

    /** The well-known folders Otter Mail asks Graph for by name. */
    static let wellKnownNames = ["inbox", "sentitems", "drafts", "deleteditems", "junkemail", "archive", "outbox", "conversationhistory", "syncissues", "scheduled"]
    private static let systemLabels = ["inbox": "INBOX", "sentitems": "SENT", "drafts": "DRAFT", "deleteditems": "TRASH", "junkemail": "SPAM"]
    /** Mail on its way out, Skype logs and sync conflicts: not mail to list. */
    private static let skipped = ["outbox", "conversationhistory", "syncissues", "scheduled"]

    /** Graph's folder resource. */
    struct ApiFolder: Decodable {
        var id: String
        var displayName: String
        var childFolderCount: Int?
    }

    /**
     * The folder tree, from each folder's children (`nil`: the top level), as
     * labels: Deleted Items' and Junk's subfolders wear their parent's label.
     */
    init(wellKnown: [String: String], children: [String?: [ApiFolder]], categories: [Category]) {
        self.wellKnown = wellKnown
        self.categories = categories
        let role = Dictionary(wellKnown.map { ($1, $0) }) { a, _ in a }
        var folders: [Folder] = []
        func visit(_ parent: String?, _ path: String, _ inherited: String?) {
            for child in children[parent] ?? [] {
                let name = role[child.id]
                if let name, Self.skipped.contains(name) { continue }
                let full = path.isEmpty ? child.displayName : "\(path)/\(child.displayName)"
                let own: String? = if let name { Self.systemLabels[name] } else { "\(Self.folderPrefix)\(child.id)" }
                let label = inherited ?? own
                folders.append(Folder(id: child.id, name: full, parentID: parent, label: label))
                if (child.childFolderCount ?? 0) > 0 {
                    // System folders' children are named under the folder's own name ("Inbox/Clients").
                    visit(child.id, full, label == "TRASH" || label == "SPAM" ? label : nil)
                }
            }
        }
        visit(nil, "", nil)
        let order = { (folder: Folder) in
            folder.id == wellKnown["inbox"] ? 0 : folder.label == "SPAM" ? 2 : folder.label == "TRASH" ? 3 : 1
        }
        self.folders = folders.enumerated().sorted { (order($0.element), $0.offset) < (order($1.element), $1.offset) }.map(\.element)
    }

    // ── Folders ──────────────────────────────────────────────────────────────

    /** The label a folder's mail carries (nil: archived, or a folder that isn't synced). */
    func label(ofFolder id: String?) -> String? {
        guard let id else { return nil }
        if let folder = folders.first(where: { $0.id == id }) { return folder.label }
        if let name = wellKnown.first(where: { $0.value == id })?.key { return Self.systemLabels[name] }
        // A folder made since the tree was read: the next read names it.
        return "\(Self.folderPrefix)\(id)"
    }

    /** Whether mail in this folder is shown (not the Outbox or the like). */
    func isSynced(_ folderID: String?) -> Bool {
        guard let folderID else { return true }
        return !Self.skipped.contains { wellKnown[$0] == folderID }
    }

    /** The folder a label stands for, if it's one (INBOX → the inbox, …). */
    func folder(ofLabel label: String) -> String? {
        if label.hasPrefix(Self.folderPrefix) { return String(label.dropFirst(Self.folderPrefix.count)) }
        guard let name = Self.systemLabels.first(where: { $0.value == label })?.key else { return nil }
        return wellKnown[name] ?? name
    }

    /** A well-known folder's id (Graph takes the name too: an Archive it makes on first use). */
    func id(_ name: String) -> String { wellKnown[name] ?? name }

    // ── Labels ───────────────────────────────────────────────────────────────

    static func category(_ label: String) -> String? {
        label.hasPrefix(categoryPrefix) ? String(label.dropFirst(categoryPrefix.count)) : nil
    }

    /** The sidebar's labels: folders nested by path, then categories in their colors. */
    var labels: [MailLabel] {
        let byName = { (a: MailLabel, b: MailLabel) in a.name.localizedStandardCompare(b.name) == .orderedAscending }
        let folders = self.folders.filter { $0.label?.hasPrefix(Self.folderPrefix) == true }
            .map { MailLabel(id: $0.label!, name: $0.name, color: nil) }
            .sorted(by: byName)
        let categories = self.categories.map { MailLabel(id: Self.categoryPrefix + $0.name, name: $0.name, color: Self.presets[$0.color]) }
            .sorted(by: byName)
        return folders + categories
    }

    /** The labels a message wears: its folder's, its categories, and what its flag, read state and importance stand for. */
    func labels(folder: String?, isRead: Bool?, flagged: Bool, importance: String?, categories: [String]?) -> [String] {
        var labels: [String] = []
        if let label = label(ofFolder: folder) { labels.append(label) }
        if isRead == false { labels.append("UNREAD") }
        if flagged { labels.append("STARRED") }
        if importance == "high" { labels.append("IMPORTANT") }
        labels += (categories ?? []).map { Self.categoryPrefix + $0 }
        return labels
    }

    // ── Colors ───────────────────────────────────────────────────────────────

    /** Outlook's category presets, as Outlook on the web shows them. */
    static let presets = [
        "preset0": "#e74856", "preset1": "#ff8c00", "preset2": "#ab7b5d", "preset3": "#fff100", "preset4": "#47d041",
        "preset5": "#30c6cc", "preset6": "#73aa24", "preset7": "#4cb4ff", "preset8": "#8764b8", "preset9": "#f495bf",
        "preset10": "#4b7a9e", "preset11": "#2d4250", "preset12": "#a0aeb2", "preset13": "#6b7b81", "preset14": "#1f1f1f",
        "preset15": "#a4262c", "preset16": "#ca5010", "preset17": "#8e562e", "preset18": "#c19c00", "preset19": "#0b6a0b",
        "preset20": "#038387", "preset21": "#5c7e10", "preset22": "#004e8c", "preset23": "#5c2e91", "preset24": "#9b1c54",
    ]
}
