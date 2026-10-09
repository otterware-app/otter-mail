import Foundation

/** Addresses used by the app and the extension's IMAP envelope decoder. */
nonisolated struct Person: Hashable, Codable, Sendable {
    var name: String
    var email: String
    var label: String { name.isEmpty ? email : name }
    func isAddress(_ address: String) -> Bool { email.caseInsensitiveCompare(address) == .orderedSame }
}

/** Network settings shared by the app and its direct-IMAP notification reader. */
nonisolated struct MailServer: Hashable, Codable, Sendable {
    enum Security: String, Codable, CaseIterable, Sendable { case tls, starttls }
    var host: String
    var port: Int
    var security: Security
}

nonisolated struct ImapSettings: Hashable, Codable, Sendable {
    var username: String
    var imap: MailServer
    var smtp: MailServer
}
