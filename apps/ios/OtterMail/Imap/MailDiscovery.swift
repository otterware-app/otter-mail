import Foundation
import Network

/**
 * Where an address's mail servers are: the providers people use most, then
 * Thunderbird's autoconfig database, then the domain's own autoconfig file,
 * then its MX host (Thunderbird's entry for the MX's domain, or the MX itself
 * if it takes TLS on 993 under its own name), and last a guess
 * (imap.<domain>, smtp.<domain>) to check by hand.
 */
nonisolated enum MailDiscovery {
    struct Found {
        var settings: ImapSettings
        /** Where they came from, or what to know (an app-specific password). */
        var note: String
    }

    enum Failure: LocalizedError {
        case gmail, outlook

        var errorDescription: String? {
            switch self {
            case .gmail: "Add Gmail with “Add Gmail mailbox”: it signs in with Google."
            case .outlook: "Add Outlook and Hotmail with “Add Outlook mailbox”: it signs in with Microsoft."
            }
        }
    }

    static func find(_ email: String) async throws -> Found {
        let domain = email.split(separator: "@").last.map { $0.lowercased() } ?? ""
        if ["gmail.com", "googlemail.com"].contains(domain) { throw Failure.gmail }
        if ["outlook.com", "hotmail.com", "live.com", "msn.com"].contains(domain) { throw Failure.outlook }
        if let preset = preset(domain, email: email) { return preset }
        let urls = [
            "https://autoconfig.thunderbird.net/v1.1/\(domain)",
            "https://autoconfig.\(domain)/mail/config-v1.1.xml?emailaddress=\(email)",
            "https://\(domain)/.well-known/autoconfig/mail/config-v1.1.xml",
        ]
        for (index, url) in urls.enumerated() {
            guard let url = URL(string: url), let settings = await autoconfig(url, email: email) else { continue }
            return Found(settings: settings, note: index == 0 ? "Found in Thunderbird's list of mail providers." : "Found in \(domain)'s own settings.")
        }
        if let mx = await mxHost(domain) {
            let base = baseDomain(mx)
            if base != domain, let url = URL(string: "https://autoconfig.thunderbird.net/v1.1/\(base)"),
               let settings = await autoconfig(url, email: email) {
                return Found(settings: settings, note: "Found in Thunderbird's list of mail providers, for \(base).")
            }
            if await takesTLS(mx) {
                return Found(
                    settings: ImapSettings(
                        username: email,
                        imap: MailServer(host: mx, port: 993, security: .tls),
                        smtp: MailServer(host: mx, port: 465, security: .tls)
                    ),
                    note: "Your domain's mail server, from its MX record."
                )
            }
        }
        return Found(
            settings: ImapSettings(
                username: email,
                imap: MailServer(host: "imap.\(domain)", port: 993, security: .tls),
                smtp: MailServer(host: "smtp.\(domain)", port: 465, security: .tls)
            ),
            note: "Guessed from the address; check them under Server settings."
        )
    }

    /**
     * For a certificate that doesn't match the server tried: the domain's own
     * mail server, when it's another host and its certificate is good.
     */
    static func certificateHint(_ error: Error, email: String, tried hosts: [String]) async -> String? {
        let certificate = switch error {
        case NWError.tls: true
        case let error as URLError:
            [.serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateHasBadDate, .secureConnectionFailed].contains(error.code)
        default: false
        }
        let domain = email.split(separator: "@").last.map { $0.lowercased() } ?? ""
        guard
            certificate,
            let mx = await mxHost(domain),
            let host = hosts.first(where: { $0.lowercased() != mx }),
            await takesTLS(mx)
        else { return nil }
        return "Its certificate doesn't match \(host). Your domain's mail server is \(mx): use that as the server name."
    }

    // ── MX ───────────────────────────────────────────────────────────────────

    /** The domain's most preferred MX host (Cloudflare's DNS-over-HTTPS), unless it's Google's or Microsoft's. */
    private static func mxHost(_ domain: String) async -> String? {
        guard let url = URL(string: "https://cloudflare-dns.com/dns-query?name=\(domain)&type=MX") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("application/dns-json", forHTTPHeaderField: "accept")
        struct Answers: Decodable {
            struct Answer: Decodable { let type: Int; let data: String }
            let Answer: [Answer]?
        }
        guard
            let (data, _) = try? await URLSession.shared.data(for: request),
            let answers = try? JSONDecoder().decode(Answers.self, from: data).Answer
        else { return nil }
        let records: [(preference: Int, host: String)] = answers.compactMap { answer in
            let parts = answer.data.split(separator: " ")
            guard answer.type == 15, parts.count == 2, let preference = Int(parts[0]) else { return nil }
            return (preference, parts[1].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")))
        }
        guard let host = records.min(by: { $0.preference < $1.preference })?.host, !host.isEmpty else { return nil }
        let notImap = ["google.com", "googlemail.com", "outlook.com"]
        return notImap.contains { host == $0 || host.hasSuffix(".\($0)") } ? nil : host
    }

    /** mx1.mail.example.co.uk → example.co.uk, roughly. */
    private static func baseDomain(_ host: String) -> String {
        let labels = host.split(separator: ".")
        let suffixes: Set<Substring> = ["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or"]
        let suffix = labels.count > 2 && labels[labels.count - 1].count == 2 && suffixes.contains(labels[labels.count - 2])
        return labels.suffix(suffix ? 3 : 2).joined(separator: ".")
    }

    /** Whether the host completes a TLS handshake on 993 with a certificate for its own name (within 5 seconds). */
    private static func takesTLS(_ host: String) async -> Bool {
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 5
        let connection = NWConnection(host: NWEndpoint.Host(host), port: .imaps, using: NWParameters(tls: .init(), tcp: tcp))
        let queue = DispatchQueue(label: "dev.otterware.mail.discovery")
        return await withCheckedContinuation { continuation in
            // Everything runs on `queue`, so this needs no lock.
            final class Once: @unchecked Sendable { var done = false }
            let once = Once()
            let finish = { @Sendable (ok: Bool) in
                guard !once.done else { return }
                once.done = true
                connection.cancel()
                continuation.resume(returning: ok)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(true)
                case .waiting, .failed, .cancelled: finish(false)
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 5) { finish(false) }
        }
    }

    // ── Known providers ──────────────────────────────────────────────────────

    private static func preset(_ domain: String, email: String) -> Found? {
        let found = { (imap: String, smtp: String, smtpPort: Int, note: String) in
            Found(
                settings: ImapSettings(
                    username: email,
                    imap: MailServer(host: imap, port: 993, security: .tls),
                    smtp: MailServer(host: smtp, port: smtpPort, security: smtpPort == 587 ? .starttls : .tls)
                ),
                note: note
            )
        }
        switch domain {
        case "icloud.com", "me.com", "mac.com":
            return found("imap.mail.me.com", "smtp.mail.me.com", 587, "iCloud needs an app-specific password, made at account.apple.com.")
        case "fastmail.com", "fastmail.fm":
            return found("imap.fastmail.com", "smtp.fastmail.com", 465, "Fastmail needs an app password, made in its Settings › Privacy & Security.")
        case "yahoo.com", "ymail.com", "rocketmail.com":
            return found("imap.mail.yahoo.com", "smtp.mail.yahoo.com", 465, "Yahoo needs an app password, made in its Account Security.")
        case "aol.com":
            return found("imap.aol.com", "smtp.aol.com", 465, "AOL needs an app password, made in its Account Security.")
        case "gmx.com", "gmx.us":
            return found("imap.gmx.com", "mail.gmx.com", 465, "Turn on IMAP in GMX's settings first.")
        case "gmx.net", "gmx.de", "gmx.at", "gmx.ch":
            return found("imap.gmx.net", "mail.gmx.net", 465, "Turn on IMAP in GMX's settings first.")
        case "zoho.com", "zohomail.com":
            return found("imap.zoho.com", "smtp.zoho.com", 465, "Turn on IMAP in Zoho Mail's settings first.")
        case "zoho.eu", "zohomail.eu":
            return found("imap.zoho.eu", "smtp.zoho.eu", 465, "Turn on IMAP in Zoho Mail's settings first.")
        default:
            return nil
        }
    }

    // ── Autoconfig (Thunderbird's format) ────────────────────────────────────

    private static func autoconfig(_ url: URL, email: String) async -> ImapSettings? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        guard
            let (data, response) = try? await URLSession.shared.data(for: request),
            (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        let reader = AutoconfigReader()
        let parser = XMLParser(data: data)
        parser.delegate = reader
        guard parser.parse() else { return nil }
        // TLS from the start where offered, else STARTTLS; never plaintext.
        let pick = { (servers: [AutoconfigReader.Server]) in
            servers.first { $0.socketType == "SSL" } ?? servers.first { $0.socketType == "STARTTLS" }
        }
        guard let imap = pick(reader.imap), let smtp = pick(reader.smtp) else { return nil }
        let local = email.split(separator: "@").first.map(String.init) ?? email
        let domain = email.split(separator: "@").last.map(String.init) ?? ""
        let username = imap.username
            .replacingOccurrences(of: "%EMAILADDRESS%", with: email)
            .replacingOccurrences(of: "%EMAILLOCALPART%", with: local)
            .replacingOccurrences(of: "%EMAILDOMAIN%", with: domain)
        let server = { (s: AutoconfigReader.Server) in
            MailServer(host: s.hostname, port: s.port, security: s.socketType == "SSL" ? .tls : .starttls)
        }
        return ImapSettings(username: username.isEmpty ? email : username, imap: server(imap), smtp: server(smtp))
    }

    private final class AutoconfigReader: NSObject, XMLParserDelegate {
        struct Server {
            var hostname = ""
            var port = 0
            var socketType = ""
            var username = ""
        }

        var imap: [Server] = []
        var smtp: [Server] = []
        private var current: Server?
        private var kind = ""
        private var text = ""

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
            text = ""
            if name == "incomingServer" || name == "outgoingServer" {
                kind = attributes["type"] ?? ""
                current = Server()
            }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            switch name {
            case "hostname": current?.hostname = value
            case "port": current?.port = Int(value) ?? 0
            case "socketType": current?.socketType = value.uppercased()
            case "username": current?.username = value
            case "incomingServer", "outgoingServer":
                if let server = current, !server.hostname.isEmpty, server.port > 0 {
                    if kind == "imap" { imap.append(server) } else if kind == "smtp" { smtp.append(server) }
                }
                current = nil
            default: break
            }
        }
    }
}
