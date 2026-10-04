import Foundation

/** The iPhone's mail tools, using the same names as core's tools. No mail credentials go to the agent server. */
@MainActor
struct AgentMailTools {
    let store: MailStore
    let confirm: @MainActor (String, String) async -> Bool

    private static let string: [String: Any] = ["type": "string"]
    private static let boolean: [String: Any] = ["type": "boolean"]
    private static let strings: [String: Any] = ["type": "array", "items": string]

    static var definitions: [[String: Any]] {
        func tool(_ name: String, _ title: String, _ description: String, _ properties: [String: Any], _ required: [String] = []) -> [String: Any] {
            ["name": name, "title": title, "description": description,
             "input": ["type": "object", "properties": properties, "required": required]]
        }
        let account = ["account": string]
        let compose = ["account": string, "to": string, "cc": string, "bcc": string, "subject": string, "body": string,
                       "replyTo": string, "replyAll": boolean]
        return [
            tool("list_accounts", "List mailboxes", "The mailboxes available on this iPhone, by address.", [:]),
            tool("list_labels", "List labels", "A mailbox's labels and their names.", account),
            tool("list_threads", "List conversations", "Newest conversations cached on this iPhone. Label defaults to inbox. Limit is at most 100. Use search_mail for server search.",
                 ["account": string, "label": string, "unreadOnly": boolean, "limit": ["type": "integer", "minimum": 1, "maximum": 100]]),
            tool("search_mail", "Search mail", "Searches mail on the servers using Gmail search syntax, or locally when offline. Answers up to 100 cached conversations; no pagination.",
                 ["query": string, "accounts": strings], ["query"]),
            tool("get_thread", "Read a conversation", "Every message of a cached conversation, including text and attachments. Find it with search_mail first. Does not mark it read.",
                 ["account": string, "threadId": string, "includeQuoted": boolean], ["threadId"]),
            tool("get_attachment", "Read an attachment", "Returns an image, PDF or text attachment to the model. Use attachmentId from get_thread.",
                 ["account": string, "messageId": string, "attachmentId": string], ["messageId", "attachmentId"]),
            tool("update_threads", "Update conversations", "Queues changes to cached conversations: archive, moveToInbox, read/unread, star/unstar or labels. The iPhone syncs them to the mail server.",
                 ["account": string, "threadIds": strings, "archive": boolean, "moveToInbox": boolean, "read": boolean,
                  "starred": boolean, "addLabels": strings, "removeLabels": strings], ["threadIds"]),
            tool("trash_threads", "Move to Trash", "Queues conversations to be moved to Trash. Requires approval.",
                 ["account": string, "threadIds": strings], ["threadIds"]),
            tool("save_draft", "Save a draft", "Saves a new plain text draft for the user to review. replyTo is a message ID. Does not send, replace existing drafts, or attach files.", compose),
            tool("send_email", "Send email", "Sends plain text mail only when the user asks to send it. replyTo is a message ID. Requires approval showing the recipients and body.", compose),
        ]
    }

    private func fail(_ message: String) -> Hermes.Failure { Hermes.Failure(message: message) }

    private func mailboxes(_ input: [String: Any]) throws -> [Mailbox] {
        let names = (input["account"] as? String).map { [$0] } ?? input["accounts"] as? [String]
        let available = store.mailboxes.filter { !$0.signedOut && (names == nil || names!.contains($0.email)) }
        if available.isEmpty { throw fail("No matching signed-in mailbox on this iPhone. Use list_accounts.") }
        if let names, names.contains(where: { name in !available.contains { $0.email == name } }) {
            throw fail("One of those mailboxes is unavailable. Use list_accounts.")
        }
        return available
    }

    private func mailbox(_ input: [String: Any]) throws -> Mailbox {
        let found = try mailboxes(input)
        guard found.count == 1 else { throw fail("Name one mailbox with account (its address).") }
        return found[0]
    }

    private func required(_ input: [String: Any], _ key: String) throws -> String {
        guard let value = input[key] as? String, !value.isEmpty else { throw fail("\(key) is required.") }
        return value
    }

    private func label(_ name: String, _ mailbox: Mailbox) throws -> String {
        let system = ["inbox": "INBOX", "sent": "SENT", "drafts": "DRAFT", "starred": "STARRED",
                      "unread": "UNREAD", "spam": "SPAM", "trash": "TRASH", "important": "IMPORTANT", "all": "ALL"]
        if let id = system[name.lowercased()] { return id }
        guard let label = mailbox.labels.first(where: { $0.id == name || $0.name == name }) else { throw fail("Unknown label \(name). Use list_labels.") }
        return label.id
    }

    private func row(_ thread: MailThread) -> [String: Any] {
        ["account": thread.mailbox, "threadId": thread.id, "messageId": thread.latest.id, "subject": thread.subject,
         "from": thread.latest.from.email, "date": thread.latest.date.ISO8601Format(), "snippet": thread.latest.snippet,
         "unread": thread.unread, "starred": thread.starred, "labels": Array(thread.labels)]
    }

    private func draft(_ input: [String: Any], _ mailbox: Mailbox) throws -> Draft {
        var draft = Draft.new(from: mailbox)
        if let replyID = input["replyTo"] as? String {
            guard var thread = store.allThreads(of: mailbox.email).first(where: { $0.messages.contains { $0.id == replyID } }),
                  let index = thread.messages.firstIndex(where: { $0.id == replyID }) else { throw fail("Reply message not found. Use get_thread first.") }
            thread.messages = Array(thread.messages.prefix(index + 1))
            draft = Draft.reply(to: thread, in: mailbox, all: (input["replyAll"] as? Bool) ?? false)
        }
        if let to = input["to"] as? String { draft.to = to }
        if let cc = input["cc"] as? String { draft.cc = cc }
        if let bcc = input["bcc"] as? String { draft.bcc = bcc }
        if let subject = input["subject"] as? String { draft.subject = subject }
        draft.body = try required(input, "body")
        return draft
    }

    func run(_ name: String, _ input: [String: Any]) async -> [String: Any] {
        do {
            try Task.checkCancellation()
            let value = try await execute(name, input)
            if value["file"] != nil { return value.merging(["isError": false]) { old, _ in old } }
            let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
            return ["text": String(String(decoding: data, as: UTF8.self).prefix(30_000)), "isError": false]
        } catch {
            return ["text": error.localizedDescription, "isError": true]
        }
    }

    /** File results are returned separately, so the server's model sees their content. */
    func execute(_ name: String, _ input: [String: Any]) async throws -> [String: Any] {
        switch name {
        case "list_accounts":
            return ["mailboxes": store.mailboxes.map { ["account": $0.email, "name": $0.displayName.isEmpty ? $0.name : $0.displayName,
                                                       "provider": $0.provider.rawValue, "signedOut": $0.signedOut] as [String: Any] }]
        case "list_labels":
            return ["labels": try mailbox(input).labels.map { ["name": $0.name, "id": $0.id] }]
        case "list_threads", "search_mail":
            let accounts = try mailboxes(input)
            var found: [MailThread] = []
            for account in accounts {
                if name == "search_mail" {
                    let query = try required(input, "query")
                    let ids = await store.sync?.search(query, scope: account.email)
                    let cached = store.search(query, scope: account.email)
                    let remote = ids.map { ids in store.allThreads(of: account.email).filter { ids.contains($0.id) } } ?? []
                    let seen = Set(remote.map(\.id))
                    found += remote + cached.filter { !seen.contains($0.id) }
                } else {
                    let id = try label((input["label"] as? String) ?? "inbox", account)
                    found += store.allThreads(of: account.email).filter { thread in
                        let match = id == "ALL" ? thread.labels.isDisjoint(with: ["SPAM", "TRASH"]) :
                            id == "STARRED" ? thread.starred : id == "UNREAD" ? thread.unread : thread.labels.contains(id)
                        return match && (input["unreadOnly"] as? Bool != true || thread.unread)
                    }
                }
            }
            return ["threads": found.sorted { $0.latest.date > $1.latest.date }.prefix(max(1, min((input["limit"] as? Int) ?? 100, 100))).map(row)]
        case "get_thread":
            let account = try mailbox(input)
            guard let thread = store.allThreads(of: account.email).first(where: { $0.id == input["threadId"] as? String }) else { throw fail("Conversation not found. Use search_mail first.") }
            return ["account": account.email, "threadId": thread.id, "subject": thread.subject, "labels": Array(thread.labels),
                    "messages": thread.messages.map { message -> [String: Any] in
                        ["messageId": message.id, "from": message.from.email, "to": message.to.map(\.email), "cc": message.cc.map(\.email),
                         "date": message.date.ISO8601Format(), "body": String((input["includeQuoted"] as? Bool == true ? message.text : Quote.split(message.text).body).prefix(30_000)),
                         "attachments": message.attachments.enumerated().map { index, file in
                             ["attachmentId": file.id ?? "local-\(index)", "filename": file.filename, "mimeType": file.mimeType, "size": file.size] as [String: Any]
                         }]
                    }]
        case "get_attachment":
            let account = try mailbox(input)
            let id = try required(input, "attachmentId")
            guard let message = store.allThreads(of: account.email).flatMap(\.messages).first(where: { $0.id == input["messageId"] as? String }),
                  let entry = message.attachments.enumerated().first(where: { ($0.element.id ?? "local-\($0.offset)") == id }) else { throw fail("Attachment not found. Use get_thread first.") }
            let file = entry.element
            guard file.size <= 50 * 1024 * 1024,
                  file.mimeType.hasPrefix("image/") || file.mimeType.hasPrefix("text/") || ["application/pdf", "application/json", "application/xml", "message/rfc822"].contains(file.mimeType) else {
                throw fail("Use an image, PDF or text attachment smaller than 50 MB.")
            }
            let url = try await store.attachmentURL(file, of: message, in: account.email)
            let data = try Data(contentsOf: url)
            guard data.count <= 50 * 1024 * 1024 else { throw fail("This attachment is larger than 50 MB.") }
            return ["file": ["name": file.filename, "mime": file.mimeType, "data": data.base64EncodedString()], "text": "Read \(file.filename)."]
        case "save_draft", "send_email":
            let account = try mailbox(input)
            let draft = try draft(input, account)
            if name == "send_email" {
                guard draft.canSend else { throw Draft.Failure.invalidRecipients }
                guard await confirm(name, "Send from \(account.email)\nTo: \(draft.to)\nCc: \(draft.cc)\nBcc: \(draft.bcc)\nSubject: \(draft.subject)\n\n\(draft.body)") else { throw fail("The user declined.") }
                try Task.checkCancellation()
                try await store.send(draft)
                return ["sent": true]
            }
            try await store.save(draft)
            return ["saved": true, "note": "The draft is in Drafts for the user to review."]
        case "update_threads", "trash_threads":
            let account = try mailbox(input)
            guard let ids = input["threadIds"] as? [String], !ids.isEmpty, ids.count <= 100 else { throw fail("Provide 1 to 100 conversation IDs.") }
            let threads = try Set(ids).sorted().map { id -> MailThread in
                guard let thread = store.allThreads(of: account.email).first(where: { $0.id == id }) else { throw fail("Conversation \(id) is not on this iPhone. Use search_mail.") }
                return thread
            }
            let add = try (input["addLabels"] as? [String] ?? []).map { try label($0, account) }
            let remove = try (input["removeLabels"] as? [String] ?? []).map { try label($0, account) }
            for id in add + remove where !account.labels.contains(where: { $0.id == id }) {
                throw fail("Use archive, moveToInbox, read and starred for system folders and flags. addLabels/removeLabels take custom labels.")
            }
            guard !(input["archive"] as? Bool == true && input["moveToInbox"] as? Bool == true) else { throw fail("Choose archive or moveToInbox.") }
            guard name == "trash_threads" || input["archive"] as? Bool == true || input["moveToInbox"] as? Bool == true ||
                  input["read"] is Bool || input["starred"] is Bool || !add.isEmpty || !remove.isEmpty else { throw fail("Nothing to change.") }
            let detail = String(decoding: try JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)
            guard await confirm(name, "\(threads.map(\.subject).joined(separator: "\n"))\n\n\(detail)") else { throw fail("The user declined.") }
            try Task.checkCancellation()
            for thread in threads {
                if name == "trash_threads" { store.trash(thread.id); continue }
                if input["archive"] as? Bool == true { store.archive(thread.id) }
                if input["moveToInbox"] as? Bool == true { store.moveToInbox(thread.id) }
                if let read = input["read"] as? Bool { store.setRead(read, thread.id) }
                if let star = input["starred"] as? Bool, star != thread.starred { store.toggleStar(thread.id) }
                for id in add where !thread.labels.contains(id) { store.toggleLabel(id, thread.id) }
                for id in remove where thread.labels.contains(id) { store.toggleLabel(id, thread.id) }
            }
            store.commitPendingAction()
            return ["queued": threads.count]
        default: throw fail("This tool is not available on the iPhone.")
        }
    }
}
