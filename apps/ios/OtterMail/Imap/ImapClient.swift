import Foundation

/** How to log in to a mail server: a password, or an OAuth access token (XOAUTH2, for Outlook later). */
nonisolated enum MailAuth: Sendable {
    case password(String)
    case oauth(String)

    /** SASL PLAIN's or XOAUTH2's initial response, base64. */
    func sasl(_ username: String) -> String {
        switch self {
        case .password(let password): Data("\0\(username)\0\(password)".utf8).base64EncodedString()
        case .oauth(let token): Data("user=\(username)\u{1}auth=Bearer \(token)\u{1}\u{1}".utf8).base64EncodedString()
        }
    }
}

nonisolated enum ImapError: LocalizedError {
    case closed
    /** No password on this iPhone. */
    case signedOut
    /** The server refused the login. */
    case authentication(String)
    /** The server said NO or BAD (IMAP), or 4xx/5xx (SMTP). */
    case server(String)
    /** Busy or unwell (UNAVAILABLE, SERVERBUG, LIMIT, INUSE): a refused login then isn't a wrong password. */
    case unavailable(String)
    case protocolError(String)

    var isSignedOut: Bool {
        switch self {
        case .signedOut, .authentication: true
        default: false
        }
    }

    var errorDescription: String? {
        switch self {
        case .closed: "The mail server closed the connection."
        case .signedOut: "Enter the password for this mailbox in Settings › Mailboxes."
        case .authentication(let text): text.isEmpty ? "The server didn't accept the username or password." : text
        case .server(let text), .unavailable(let text), .protocolError(let text): text
        }
    }
}

/** A folder as LIST answers it. */
nonisolated struct ImapFolder: Hashable, Codable, Sendable {
    var path: String
    var delimiter: String?
    /** Lowercased: \noselect, \sent, \trash, … */
    var attributes: Set<String>
}

/**
 * One IMAP connection (RFC 3501, with IDLE, UIDPLUS, MOVE, CONDSTORE and
 * QRESYNC when the server has them): a command at a time, each answered
 * with its untagged responses. Callers keep one connection per job (sync,
 * IDLE) and take turns on it.
 */
actor ImapClient {
    private let socket: MailSocket
    /** Closed from outside the actor when a command hangs or IDLE is cancelled. */
    nonisolated let transport: any MailTransport
    private(set) var capabilities: Set<String> = []
    private(set) var selected: String?
    private var tag = 0
    private var idleOpen = false

    struct Reply: Sendable {
        var untagged: [ImapResponse]
        /** The tagged OK's response code (`APPENDUID 9 12`). */
        var code: [ImapValue]
    }

    struct Status: Sendable {
        var uidValidity: UInt32
        var uidNext: UInt32
        var highestModSeq: UInt64?
        var exists: Int
    }

    private init(_ socket: MailSocket) {
        self.socket = socket
        transport = socket.transport
    }

    /** Connects, upgrades to TLS if need be, logs in, and turns on QRESYNC where there is one. */
    static func connect(_ server: MailServer, username: String, auth: MailAuth, maxResponseBytes: Int = MailSocket.maxLiteral) async throws -> ImapClient {
        let client = ImapClient(try await MailSocket.open(server, maxResponseBytes: maxResponseBytes))
        do {
            try await client.start(server, username: username, auth: auth)
        } catch {
            client.close()
            throw error
        }
        return client
    }

    private func start(_ server: MailServer, username: String, auth: MailAuth) async throws {
        let greeting = ImapParser.response(Data(try await readResponse().dropFirst(2)))
        guard greeting.kind == "OK" || greeting.kind == "PREAUTH" else { throw ImapError.server(greeting.text) }
        take(greeting.values)
        if server.security == .starttls {
            if capabilities.isEmpty { try await refreshCapabilities() }
            guard capabilities.contains("STARTTLS") else {
                throw ImapError.protocolError("\(server.host) doesn't offer STARTTLS. Try port 993 with TLS.")
            }
            try await command("STARTTLS")
            try await socket.startTLS()
            capabilities = []
        }
        if greeting.kind != "PREAUTH" {
            if capabilities.isEmpty { try await refreshCapabilities() }
            try await login(username, auth)
        }
        if !capabilities.contains("IMAP4REV1") && !capabilities.contains("IMAP4REV2") { try await refreshCapabilities() }
        if capabilities.contains("QRESYNC") { try await command("ENABLE QRESYNC") }
    }

    private func login(_ username: String, _ auth: MailAuth) async throws {
        do {
            let reply: Reply
            switch auth {
            case .oauth:
                reply = try await authenticate("XOAUTH2", auth.sasl(username))
            case .password where capabilities.contains("AUTH=PLAIN"):
                reply = try await authenticate("PLAIN", auth.sasl(username))
            case .password(let password):
                reply = try await command("LOGIN \(Self.quote(username)) \(Self.quote(password))")
            }
            take(reply.code)
        } catch ImapError.server(let text) {
            throw ImapError.authentication(text)
        }
    }

    private func authenticate(_ mechanism: String, _ response: String) async throws -> Reply {
        capabilities.contains("SASL-IR")
            ? try await command("AUTHENTICATE \(mechanism) \(response)")
            : try await command("AUTHENTICATE \(mechanism)", continuation: Data("\(response)\r\n".utf8))
    }

    private func refreshCapabilities() async throws {
        let reply = try await command("CAPABILITY")
        for response in reply.untagged where response.kind == "CAPABILITY" { take([.atom("CAPABILITY")] + response.values) }
    }

    /** A CAPABILITY response or response code. */
    private func take(_ code: [ImapValue]) {
        guard code.first?.text?.uppercased() == "CAPABILITY" else { return }
        capabilities = Set(code.dropFirst().compactMap { $0.text?.uppercased() })
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    /**
     * Sends a command and collects what the server answers until it's done.
     * `literal` is sent as the command's last argument; `continuation` when
     * the server asks for more ("+"), as AUTHENTICATE does.
     */
    @discardableResult
    func command(_ text: String, literal: Data? = nil, continuation: Data? = nil) async throws -> Reply {
        tag += 1
        let tag = "A\(tag)"
        var pending = continuation
        if let literal {
            if capabilities.contains("LITERAL+") {
                try await socket.write(Data("\(tag) \(text) {\(literal.count)+}\r\n".utf8) + literal + Data("\r\n".utf8))
            } else {
                try await socket.write("\(tag) \(text) {\(literal.count)}\r\n")
                pending = literal + Data("\r\n".utf8)
            }
        } else {
            try await socket.write("\(tag) \(text)\r\n")
        }
        // A server that stops answering mid-command would hold its caller forever.
        let watchdog = Task { [transport] in
            try? await Task.sleep(for: .seconds(90))
            if !Task.isCancelled { transport.close() }
        }
        defer { watchdog.cancel() }

        var untagged: [ImapResponse] = []
        while true {
            let line = try await readResponse()
            if line.starts(with: "+".utf8) {
                try await socket.write(pending ?? Data("\r\n".utf8))
                pending = nil
            } else if line.starts(with: "* ".utf8) {
                untagged.append(ImapParser.response(Data(line.dropFirst(2))))
            } else if line.starts(with: "\(tag) ".utf8) {
                let status = ImapParser.response(Data(line.dropFirst(tag.count + 1)))
                guard status.kind == "OK" else {
                    let code = status.values.first?.text?.uppercased() ?? ""
                    throw ["UNAVAILABLE", "SERVERBUG", "LIMIT", "INUSE"].contains(code)
                        ? ImapError.unavailable(status.text) : ImapError.server(status.text)
                }
                return Reply(untagged: untagged, code: status.values)
            }
        }
    }

    /** A response: its line, and any literals it carries with the lines after them. */
    private func readResponse() async throws -> Data {
        var out = Data()
        while true {
            let line = try await socket.readLine()
            out.append(line)
            guard
                line.last == UInt8(ascii: "}"),
                let open = line.lastIndex(of: UInt8(ascii: "{")),
                let count = Int(String(decoding: line[(open + 1)..<(line.endIndex - 1)], as: UTF8.self).replacingOccurrences(of: "+", with: ""))
            else { return out }
            // A message is seldom past a few tens of MB: a server offering more is broken or hostile.
            guard out.count + count <= MailSocket.maxLiteral else { throw ImapError.protocolError("The mail server sent too much at once.") }
            out.append(Data("\r\n".utf8))
            out.append(try await socket.read(count))
        }
    }

    /** A string argument: quoted, escaped. */
    static func quote(_ text: String) -> String {
        "\"\(text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\""
    }

    // ── Folders ──────────────────────────────────────────────────────────────

    func list() async throws -> [ImapFolder] {
        let specialUse = capabilities.contains("SPECIAL-USE") && capabilities.contains("LIST-EXTENDED")
        let reply = try await command(specialUse ? #"LIST "" "*" RETURN (SPECIAL-USE)"# : #"LIST "" "*""#)
        return reply.untagged.filter { $0.kind == "LIST" }.compactMap { response in
            let values = response.values
            guard values.count >= 3, let path = values[2].text else { return nil }
            return ImapFolder(path: path, delimiter: values[1].text, attributes: Set(values[0].list.compactMap { $0.text?.lowercased() }))
        }
    }

    func create(_ path: String) async throws {
        try await command("CREATE \(Self.quote(path))")
    }

    /** Opens a folder (read-write), with where it's at. */
    @discardableResult
    func select(_ path: String, readOnly: Bool = false) async throws -> Status {
        let condstore = capabilities.contains("CONDSTORE") && !capabilities.contains("QRESYNC")
        selected = nil
        let reply = try await command("\(readOnly ? "EXAMINE" : "SELECT") \(Self.quote(path))\(condstore ? " (CONDSTORE)" : "")")
        selected = path
        var status = Status(uidValidity: 0, uidNext: 0, highestModSeq: nil, exists: 0)
        for response in reply.untagged {
            if response.kind == "EXISTS" { status.exists = Int(response.number ?? 0) }
            guard response.kind == "OK", let code = response.values.first?.text?.uppercased(), response.values.count > 1 else { continue }
            let value = response.values[1].number ?? 0
            switch code {
            case "UIDVALIDITY": status.uidValidity = UInt32(clamping: value)
            case "UIDNEXT": status.uidNext = UInt32(clamping: value)
            case "HIGHESTMODSEQ": status.highestModSeq = value
            default: break
            }
        }
        if status.uidNext == 0 {
            // Not every server says; the newest message's UID tells.
            let newest = status.exists > 0 ? try await fetch("*", "(UID)").compactMap { $0.values.first?.pairs["UID"]?.number }.max() : nil
            status.uidNext = UInt32(clamping: (newest ?? 0) + 1)
        }
        return status
    }

    /** Opens the folder unless it's open already. */
    func open(_ path: String) async throws {
        if selected != path { try await select(path) }
    }

    /** Where a folder is at, without opening it (only asked when there's CONDSTORE). */
    func status(_ path: String) async throws -> Status? {
        let reply = try await command("STATUS \(Self.quote(path)) (UIDVALIDITY UIDNEXT MESSAGES HIGHESTMODSEQ)")
        guard let items = reply.untagged.first(where: { $0.kind == "STATUS" })?.values.last?.pairs else { return nil }
        return Status(
            uidValidity: UInt32(clamping: items["UIDVALIDITY"]?.number ?? 0),
            uidNext: UInt32(clamping: items["UIDNEXT"]?.number ?? 0),
            highestModSeq: items["HIGHESTMODSEQ"]?.number,
            exists: Int(items["MESSAGES"]?.number ?? 0)
        )
    }

    // ── Messages (in the open folder) ────────────────────────────────────────

    func search(_ criteria: String) async throws -> [UInt32] {
        let reply = try await command("UID SEARCH \(criteria)")
        return reply.untagged.filter { $0.kind == "SEARCH" }.flatMap { $0.values.compactMap { $0.number.map { UInt32(clamping: $0) } } }
    }

    /** FETCH responses (and VANISHED ones, with QRESYNC's modifier). */
    func fetch(_ uids: String, _ items: String, modifiers: String = "") async throws -> [ImapResponse] {
        let reply = try await command("UID FETCH \(uids) \(items)\(modifiers.isEmpty ? "" : " \(modifiers)")")
        return reply.untagged.filter { $0.kind == "FETCH" || $0.kind == "VANISHED" }
    }

    func store(_ uids: [UInt32], _ change: String) async throws {
        guard !uids.isEmpty else { return }
        try await command("UID STORE \(imapSet(uids)) \(change)")
    }

    /** Moves messages to `path`; answers their new UIDs there (when the server says, UIDPLUS). */
    func move(_ uids: [UInt32], to path: String) async throws -> [UInt32: UInt32] {
        guard !uids.isEmpty else { return [:] }
        let reply: Reply
        if capabilities.contains("MOVE") {
            reply = try await command("UID MOVE \(imapSet(uids)) \(Self.quote(path))")
        } else {
            reply = try await command("UID COPY \(imapSet(uids)) \(Self.quote(path))")
            try await delete(uids)
        }
        let codes = [reply.code] + reply.untagged.filter { $0.kind == "OK" }.map(\.values)
        guard let copy = codes.first(where: { $0.first?.text?.uppercased() == "COPYUID" }), copy.count == 4 else { return [:] }
        return Dictionary(zip(imapUIDs(copy[2].text ?? ""), imapUIDs(copy[3].text ?? ""))) { a, _ in a }
    }

    /**
     * Deletes messages for good: marks them \Deleted and expunges just those
     * (UID EXPUNGE). Without UIDPLUS, EXPUNGE takes every \Deleted message in
     * the folder, other clients' pending deletes too, so it runs only when
     * nothing but ours is marked; otherwise ours stay marked (sync hides
     * \Deleted mail) until the folder is expunged.
     */
    func delete(_ uids: [UInt32]) async throws {
        guard !uids.isEmpty else { return }
        try await store(uids, #"+FLAGS.SILENT (\Deleted)"#)
        if capabilities.contains("UIDPLUS") {
            try await command("UID EXPUNGE \(imapSet(uids))")
        } else if Set(try await search("DELETED")).isSubset(of: uids) {
            try await command("EXPUNGE")
        }
    }

    /** Adds a message to a folder; answers its UIDVALIDITY and UID there (when the server says, UIDPLUS). */
    func append(_ message: Data, to path: String, flags: String) async throws -> (validity: UInt32, uid: UInt32)? {
        let reply = try await command("APPEND \(Self.quote(path)) (\(flags))", literal: message)
        guard reply.code.first?.text?.uppercased() == "APPENDUID", reply.code.count == 3,
              let validity = reply.code[1].number, let uid = reply.code[2].number
        else { return nil }
        return (UInt32(clamping: validity), UInt32(clamping: uid))
    }

    // ── Watching ─────────────────────────────────────────────────────────────

    /**
     * Waits in IDLE on the open folder until something changes there (true)
     * or `duration` passes (false), as servers drop an IDLE after 30 minutes.
     */
    func idle(for duration: Duration) async throws -> Bool {
        tag += 1
        let tag = "A\(tag)"
        try await socket.write("\(tag) IDLE\r\n")
        idleOpen = true
        let timer = Task { [weak self] in
            try? await Task.sleep(for: duration)
            if !Task.isCancelled { await self?.endIdle() }
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            var changed = false
            while true {
                let line = try await readResponse()
                if line.starts(with: "\(tag) ".utf8) { return changed }
                guard line.starts(with: "* ".utf8) else { continue }
                if ["EXISTS", "EXPUNGE", "FETCH", "VANISHED"].contains(ImapParser.response(Data(line.dropFirst(2))).kind) {
                    changed = true
                    await endIdle()
                }
            }
        } onCancel: { [transport] in
            transport.close()
        }
    }

    private func endIdle() async {
        guard idleOpen else { return }
        idleOpen = false
        try? await socket.write("DONE\r\n")
    }

    func noop() async throws {
        try await command("NOOP")
    }

    func logout() async {
        _ = try? await command("LOGOUT")
        socket.close()
    }

    nonisolated func close() { transport.close() }
}
