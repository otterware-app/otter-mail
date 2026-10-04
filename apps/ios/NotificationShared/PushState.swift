import Foundation
import CryptoKit
import Darwin

/** Only routing/preferences/history markers in the App Group; secrets are in its Keychain group. */
nonisolated enum PushState {
    static var group: String { Bundle.main.object(forInfoDictionaryKey: "NotificationAppGroup") as? String ?? "" }
    static var directory: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appending(path: "Notifications", directoryHint: .isDirectory) }

    struct Configuration: Codable, Equatable, Sendable {
        var userId: String
        var mode: String
        var mailboxes: [String]
    }

    struct Cursor: Codable, Sendable {
        var userId: String
        var historyId: String
    }

    static func configuration() -> Configuration? { read("configuration") }

    static func configure(_ configuration: Configuration?) {
        try? write(configuration, "configuration")
    }

    static func cursor(_ email: String) -> Cursor? { read(name(email)) }
    static func save(_ cursor: Cursor?, email: String) throws { try write(cursor, name(email)) }

    static func permits(userId: String, email: String) -> Bool {
        guard let config = configuration() else { return false }
        return config.userId == userId && config.mode != "off" && config.mailboxes.contains(email.lowercased())
    }

    /** Nonblocking flock retries yield, including between app and extension processes. */
    static func locked<T>(_ key: String, isolation: isolated (any Actor)? = #isolation, body: () async throws -> T) async throws -> T {
        guard let directory else { throw Failure.unavailable }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let path = directory.appending(path: "lock-" + name(key)).path
        let fd = open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw Failure.unavailable }
        defer { flock(fd, LOCK_UN); close(fd) }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
        let deadline = ContinuousClock.now + .seconds(20)
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            try Task.checkCancellation()
            guard ContinuousClock.now < deadline else { throw Failure.unavailable }
            try await Task.sleep(for: .milliseconds(25))
        }
        try Task.checkCancellation()
        return try await body()
    }

    enum Failure: Error { case unavailable }

    private static func name(_ value: String) -> String {
        SHA256.hash(data: Data(value.lowercased().utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func read<T: Decodable>(_ key: String) -> T? {
        guard let url = directory?.appending(path: key + ".json"), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private static func write<T: Encodable>(_ value: T?, _ key: String) throws {
        guard let directory else { throw Failure.unavailable }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let url = directory.appending(path: key + ".json")
        guard let value else { try? FileManager.default.removeItem(at: url); return }
        try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
