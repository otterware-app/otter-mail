import Foundation
import Security

/** Secrets on this iPhone: the Otter session, each mailbox's Google refresh token or IMAP password. */
nonisolated enum Keychain {
    private static let service = "dev.otterware.mail"

    static func get(_ key: String) -> String? {
        var result: AnyObject?
        var query = query(key)
        query[kSecReturnData as String] = true
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    /** Keeps `value` (readable after the first unlock, for background refresh); `thisDeviceOnly` leaves it out of backups. */
    @discardableResult
    static func set(_ key: String, _ value: String?, thisDeviceOnly: Bool = false) -> Bool {
        let query = query(key)
        guard let value else {
            let status = SecItemDelete(query as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: (thisDeviceOnly || key.hasPrefix("google-") || key.hasPrefix("microsoft-") || key.hasPrefix("imap-password:")) ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly : kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status != errSecItemNotFound { return status == errSecSuccess }
        return SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil) == errSecSuccess
    }

    private static func query(_ key: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        if key.hasPrefix("google-") || key.hasPrefix("microsoft-") || key.hasPrefix("imap-password:") { query[kSecAttrAccessGroup as String] = PushState.group }
        return query
    }
}
