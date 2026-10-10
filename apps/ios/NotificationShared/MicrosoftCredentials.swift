import Foundation

/** On-device OAuth shared with the extension; refreshes go directly to Microsoft. */
nonisolated enum MicrosoftCredentials {
    static let clientID = "b0c4e8bf-e651-456e-9bc6-408a741b36f9"
    static let authority = "https://login.microsoftonline.com/common/oauth2/v2.0"
    static let scopes = ["openid", "email", "profile", "offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.ReadWrite", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/MailboxSettings.ReadWrite", "https://graph.microsoft.com/Calendars.ReadWrite"]
    struct Tokens: Codable, Sendable { var accessToken: String; var idToken: String?; var expiresAt: Date }
    struct Response: Decodable {
        var access_token: String?; var expires_in: Double?; var refresh_token: String?; var id_token: String?; var error: String?
        var tokens: Tokens { .init(accessToken: access_token ?? "", idToken: id_token, expiresAt: .now.addingTimeInterval((expires_in ?? 3600) - 60)) }
    }
    enum Failure: Error { case revoked, unavailable }
    static func refreshKey(_ email: String) -> String { "microsoft-refresh-token:\(email.lowercased())" }
    private static func accessKey(_ email: String) -> String { "microsoft-access-token:\(email.lowercased())" }

    static func save(_ email: String, refreshToken: String) async throws {
        try await PushState.locked("microsoft-oauth:" + email) {
            guard Keychain.set(refreshKey(email), refreshToken, thisDeviceOnly: true) else { throw Failure.unavailable }
            Keychain.set(accessKey(email), nil)
        }
    }
    static func refresh(_ email: String, force: Bool = false) async throws -> Tokens {
        try await PushState.locked("microsoft-oauth:" + email) {
            guard let saved = Keychain.get(refreshKey(email)) else { throw Failure.revoked }
            if !force, let cached = Keychain.get(accessKey(email)), let data = cached.data(using: .utf8), let tokens = try? JSONDecoder().decode(Tokens.self, from: data), tokens.expiresAt > .now { return tokens }
            let response: Response
            do { response = try await request(["grant_type": "refresh_token", "refresh_token": saved]) }
            catch Failure.revoked { if Keychain.get(refreshKey(email)) == saved { forget(email) }; throw Failure.revoked }
            try Task.checkCancellation()
            guard Keychain.get(refreshKey(email)) == saved else { throw Failure.revoked }
            if let rotated = response.refresh_token { Keychain.set(refreshKey(email), rotated, thisDeviceOnly: true) }
            let tokens = response.tokens
            Keychain.set(accessKey(email), String(data: try JSONEncoder().encode(tokens), encoding: .utf8), thisDeviceOnly: true)
            return tokens
        }
    }
    static func forget(_ email: String) { Keychain.set(refreshKey(email), nil); Keychain.set(accessKey(email), nil); Keychain.removeLegacy(refreshKey(email)) }
    static func request(_ params: [String: String]) async throws -> Response {
        var request = URLRequest(url: URL(string: "\(authority)/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = GoogleCredentials.form(params.merging(["client_id": clientID, "scope": scopes.joined(separator: " ")]) { value, _ in value })
        let (data, http) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(Response.self, from: data)
        if ["invalid_grant", "interaction_required", "consent_required", "login_required"].contains(response.error ?? "") { throw Failure.revoked }
        guard (http as? HTTPURLResponse)?.statusCode == 200, response.access_token != nil else { throw Failure.unavailable }
        return response
    }
}
