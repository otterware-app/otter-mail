import Foundation

/** Reads only the message the server confirmed, directly from the user's provider. */
nonisolated enum VerifiedNotification {
    struct Metadata: Decodable, Sendable {
        var version: Int
        var userId: String
        var email: String
        var provider: String
        var historyId: String
        var messageId: String
        var folder: String?
        var uidValidity: UInt32?
        var mode: String
    }
    struct Message: Sendable {
        var id: String
        var threadId: String?
        var sender: String
        var subject: String
        var preview: String
    }

    static func enrich(_ metadata: Metadata, configuration: PushState.Configuration,
                       getGmail: (@Sendable (String, [URLQueryItem]) async throws -> Data)? = nil) async throws -> Message? {
        guard metadata.version == 2, metadata.userId == configuration.userId,
              configuration.mode != "off", configuration.mailboxes.contains(metadata.email.lowercased()) else { return nil }
        let mode = metadata.mode == "all" && configuration.mode == "all" ? "all" : "inbox"
        switch metadata.provider {
        case "gmail":
            guard !metadata.messageId.isEmpty, metadata.messageId.allSatisfy(\.isHexDigit) else { return nil }
            let get = getGmail ?? GmailNotification.direct(email: metadata.email).get
            let data = try await get("messages/" + metadata.messageId, [.init(name: "format", value: "metadata"), .init(name: "metadataHeaders", value: "From"), .init(name: "metadataHeaders", value: "Subject"), .init(name: "fields", value: "id,threadId,labelIds,snippet,payload/headers")])
            let message = try JSONDecoder().decode(GmailNotification.Message.self, from: data)
            guard message.eligible(mode) else { return nil }
            return .init(id: message.id, threadId: message.threadId, sender: message.sender, subject: message.header("Subject"), preview: message.preview)
        case "outlook": return try await outlook(metadata, mode: mode)
        case "imap":
            guard let settings = configuration.imapSettings?[metadata.email.lowercased()],
                  let password = Keychain.get("imap-password:" + metadata.email.lowercased()) else { return nil }
            return try await imap(metadata, settings: settings, password: password)
        default: return nil
        }
    }

    private static func outlook(_ metadata: Metadata, mode: String) async throws -> Message? {
        struct GraphMessage: Decodable {
            struct Address: Decodable { struct Email: Decodable { var name: String?; var address: String? }; var emailAddress: Email }
            var id: String; var conversationId: String?; var from: Address?; var subject: String?; var bodyPreview: String?
            var isRead: Bool; var isDraft: Bool; var parentFolderId: String
        }
        func get(_ path: String) async throws -> Data {
            for attempt in 0..<2 {
                let token = try await MicrosoftCredentials.refresh(metadata.email, force: attempt > 0)
                var request = URLRequest(url: URL(string: "https://graph.microsoft.com/v1.0/" + path)!)
                request.timeoutInterval = 8
                request.setValue("Bearer \(token.accessToken)", forHTTPHeaderField: "Authorization")
                request.setValue("IdType=\"ImmutableId\"", forHTTPHeaderField: "Prefer")
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status == 200 { return data }
                if status == 401 && attempt == 0 { continue }
                throw GmailNotification.Failure(status: status)
            }
            throw GmailNotification.Failure(status: 401)
        }
        let id = metadata.messageId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        guard !id.isEmpty, id.count < 4096 else { return nil }
        let message = try JSONDecoder().decode(GraphMessage.self, from: await get("me/messages/\(id)?$select=id,conversationId,from,subject,bodyPreview,isRead,isDraft,parentFolderId"))
        guard !message.isRead, !message.isDraft else { return nil }
        if mode == "inbox" {
            struct Folder: Decodable { var id: String }
            let inbox = try JSONDecoder().decode(Folder.self, from: await get("me/mailFolders/inbox?$select=id"))
            guard inbox.id == message.parentFolderId else { return nil }
        }
        let from = message.from?.emailAddress
        return .init(id: message.id, threadId: message.conversationId, sender: from?.name.flatMap { $0.isEmpty ? nil : $0 } ?? from?.address ?? "New mail", subject: message.subject ?? "", preview: MailDecoding.preview(message.bodyPreview ?? "", limit: 500))
    }

    struct Part {
        var path: String; var html: Bool; var encoding: String; var charset: String?
    }
    static func parts(_ structure: ImapValue, path: String = "") -> [Part] {
        let list = structure.list
        guard !list.isEmpty else { return [] }
        if !list[0].list.isEmpty {
            return list.prefix(while: { !$0.list.isEmpty }).enumerated().flatMap { i, value in
                parts(value, path: path.isEmpty ? String(i + 1) : path + "." + String(i + 1))
            }
        }
        guard list.count > 6, list[0].text?.uppercased() == "TEXT", ["PLAIN", "HTML"].contains(list[1].text?.uppercased() ?? "") else { return [] }
        return [.init(path: path.isEmpty ? "TEXT" : path, html: list[1].text?.uppercased() == "HTML", encoding: list[5].text ?? "", charset: list[2].pairs["CHARSET"]?.text)]
    }
    private static func imap(_ metadata: Metadata, settings: ImapSettings, password: String) async throws -> Message? {
        guard let uid = UInt32(metadata.messageId), uid > 0, let validity = metadata.uidValidity,
              let folder = metadata.folder, !folder.isEmpty else { return nil }
        let client = try await ImapClient.connect(settings.imap, username: settings.username, auth: .password(password), maxResponseBytes: 65_536)
        defer { client.close() }
        return try await withTaskCancellationHandler {
            let selected = try await client.select(folder, readOnly: true)
            guard selected.uidValidity == validity else { return nil }
            let responses = try await client.fetch(String(uid), "(UID FLAGS ENVELOPE BODYSTRUCTURE)")
            guard let fields = responses.first(where: { $0.kind == "FETCH" })?.values.first?.pairs,
                  fields["UID"]?.number == UInt64(uid) else { return nil }
            let flags = Set(fields["FLAGS"]?.list.compactMap { $0.text?.lowercased() } ?? [])
            guard flags.isDisjoint(with: ["\\seen", "\\deleted", "\\draft"]) else { return nil }
            let envelope = fields["ENVELOPE"]?.list ?? []
            let subject = envelope.count > 1 ? MailDecoding.words(envelope[1].text ?? "") : ""
            var sender = "New mail"
            if envelope.count > 2, let from = envelope[2].list.first?.list, from.count >= 4 {
                let name = MailDecoding.words(from[0].text ?? "")
                sender = name.isEmpty ? (from[2].text ?? "") + "@" + (from[3].text ?? "") : name
            }
            var preview = ""
            if let structure = fields["BODYSTRUCTURE"] {
                let candidates = parts(structure)
                if let part = candidates.first(where: { !$0.html }) ?? candidates.first {
                    let body = try await client.fetch(String(uid), "(UID BODY.PEEK[\(part.path)]<0.4096>)")
                    let pairs = body.first(where: { $0.kind == "FETCH" })?.values.first?.pairs ?? [:]
                    if let data = pairs.first(where: { $0.key.hasPrefix("BODY[") })?.value.data {
                        var text = MailDecoding.text(MailDecoding.transfer(data, encoding: part.encoding), charset: part.charset)
                        if part.html {
                            text = text.replacingOccurrences(of: #"(?is)<(script|style)[^>]*>.*?(?:</\1>|$)"#, with: " ", options: .regularExpression)
                            text = text.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
                        }
                        preview = MailDecoding.preview(text, limit: 500)
                    }
                }
            }
            return .init(id: "\(validity):\(uid):\(folder)", threadId: nil, sender: sender, subject: subject, preview: preview)
        } onCancel: { client.close() }
    }
}
