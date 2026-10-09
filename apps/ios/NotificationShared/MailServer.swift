import Foundation

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
