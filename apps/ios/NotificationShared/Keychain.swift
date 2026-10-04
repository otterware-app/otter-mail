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
            kSecAttrAccessible as String: (thisDeviceOnly || key.hasPrefix("google-")) ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly : kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status != errSecItemNotFound { return status == errSecSuccess }
        return SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil) == errSecSuccess
    }

    /** Copy and verify before deleting the old app-private item; retry later if locked or not provisioned. */
    static func migrateGoogle(_ email: String) {
        let key = GoogleCredentials.refreshKey(email)
        var legacy = query(key, shared: false)
        legacy[kSecReturnData as String] = true
        var result: AnyObject?
        guard SecItemCopyMatching(legacy as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let token = String(data: data, encoding: .utf8) else { return }
        if get(key) == nil { guard set(key, token) else { return } }
        guard get(key) != nil else { return }
        SecItemDelete(query(key, shared: false) as CFDictionary)
    }

    static func removeLegacyGoogle(_ email: String) {
        SecItemDelete(query(GoogleCredentials.refreshKey(email), shared: false) as CFDictionary)
    }

    /** Moves an item kept before to this device alone (a no-op when there's none). */
    static func makeThisDeviceOnly(_ key: String) {
        let change = [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        SecItemUpdate(query(key) as CFDictionary, change as CFDictionary)
    }

    private static func query(_ key: String, shared: Bool = true) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        if shared && key.hasPrefix("google-") { query[kSecAttrAccessGroup as String] = PushState.group }
        if !shared, let legacy = Bundle.main.object(forInfoDictionaryKey: "LegacyKeychainGroup") as? String {
            query[kSecAttrAccessGroup as String] = legacy
        }
        return query
    }
}
