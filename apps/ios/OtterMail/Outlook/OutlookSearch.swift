import Foundation

/**
 * Outlook's own search (`$search`, KQL), with Gmail's common operators
 * translated as core's outlook/search.ts does: `from:`, `to:`, `cc:`, `bcc:`,
 * `subject:`, `has:attachment`, `after:`/`before:`, `newer_than:`/`older_than:`,
 * and `in:` a folder (where to search). What KQL can't say (`is:unread`,
 * `is:starred`, `is:important`, a category) is checked on each result.
 */
nonisolated enum OutlookSearch {
    struct Operator: Equatable {
        var key: String
        var value: String
        var negated: Bool
    }

    /** A label each result must wear (or, negated, mustn't). */
    struct Wanted: Equatable {
        var label: String
        var negated: Bool
    }

    struct Query: Equatable {
        /** `$search`'s KQL; nil when there's nothing to search for. */
        var kql: String?
        var wanted: [Wanted]
    }

    private static let systemLabels = [
        "inbox": "INBOX", "sent": "SENT", "draft": "DRAFT", "drafts": "DRAFT", "spam": "SPAM", "junk": "SPAM",
        "trash": "TRASH", "starred": "STARRED", "flagged": "STARRED", "unread": "UNREAD", "important": "IMPORTANT",
    ]

    static func query(_ q: String, labels: [MailLabel], now: Date = .now) -> Query {
        let (ops, text) = parse(q)
        let terms = text.split(separator: " ").map { term(String($0)) }
            + ops.compactMap { op in kql(op, now: now).map { op.negated ? "NOT \($0)" : $0 } }
        let wanted = ops.compactMap { op in label(op, labels: labels).map { Wanted(label: $0, negated: op.negated) } }
        return Query(kql: terms.isEmpty ? nil : terms.joined(separator: " "), wanted: wanted)
    }

    /** Gmail's query, split into its operators and its free text. */
    static func parse(_ q: String) -> (ops: [Operator], text: String) {
        let pattern = /(^|\s)(-?)([A-Za-z_]+):("[^"]*"|\S+)/
        let ops = q.matches(of: pattern).map { match in
            var op = Operator(key: match.3.lowercased(), value: String(match.4).trimmingCharacters(in: CharacterSet(charactersIn: "\"")), negated: match.2 == "-")
            // `is:read` is `-is:unread`.
            if op.key == "is", op.value.lowercased() == "read" { op = Operator(key: "is", value: "unread", negated: !op.negated) }
            return op
        }
        let text = q.replacing(pattern, with: " ").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return (ops, text)
    }

    /** KQL takes words and quoted phrases; quotes inside a value would end it. */
    private static func term(_ value: String) -> String {
        let clean = value.replacingOccurrences(of: "\"", with: "")
        return clean.contains(where: \.isWhitespace) ? "\"\(clean)\"" : clean
    }

    /** The KQL an operator stands for; nil when KQL can't say it. */
    static func kql(_ op: Operator, now: Date) -> String? {
        switch op.key {
        case "from", "to", "cc", "bcc", "subject":
            return "\(op.key):\(term(op.value))"
        case "has":
            return op.value.lowercased() == "attachment" ? "hasattachments:true" : nil
        case "after", "before":
            guard let date = day.date(from: op.value.replacingOccurrences(of: "/", with: "-")) else { return nil }
            return "received\(op.key == "after" ? ">=" : "<")\(day.string(from: date))"
        case "newer_than", "older_than":
            guard let match = op.value.lowercased().wholeMatch(of: /(\d+)([dwmy])/), let count = Double(match.1) else { return nil }
            let days: Double = ["d": 1, "w": 7, "m": 30, "y": 365][String(match.2)] ?? 1
            let cutoff = now.addingTimeInterval(-count * days * 86_400)
            return "received\(op.key == "newer_than" ? ">=" : "<")\(day.string(from: cutoff))"
        default:
            return nil
        }
    }

    /** The label an `in:`, `is:` or `label:` operator names, if any. */
    static func label(_ op: Operator, labels: [MailLabel]) -> String? {
        let value = op.value.lowercased()
        if op.key == "in" || op.key == "is", let system = systemLabels[value] { return system }
        guard op.key == "in" || op.key == "label" else { return nil }
        let slug = { (name: String) in name.lowercased().replacing(/[\s\/]+/, with: "-") }
        return labels.first { slug($0.name) == slug(value) || $0.id.lowercased() == value }?.id
    }

    /** A `$filter` for a label that isn't a folder (nil: it is one, or unknown). */
    static func filter(_ label: String) -> String? {
        switch label {
        case "UNREAD": return "isRead eq false"
        case "STARRED": return "flag/flagStatus eq 'flagged'"
        case "IMPORTANT": return "importance eq 'high'"
        default:
            guard let category = OutlookFolders.category(label) else { return nil }
            return "categories/any(c:c eq '\(category.replacingOccurrences(of: "'", with: "''"))')"
        }
    }

    private static let day = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}
