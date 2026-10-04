import Foundation

/** Shared by the app and extension; every Google request goes directly to Google. */
nonisolated enum GoogleCredentials {
    struct Tokens: Codable, Sendable {
        var accessToken: String
        var idToken: String?
        var expiresAt: Date
    }
    struct Response: Decodable, Sendable {
        var access_token: String?
        var expires_in: Double?
        var refresh_token: String?
        var id_token: String?
        var error: String?

        var tokens: Tokens {
            Tokens(accessToken: access_token ?? "", idToken: id_token,
                   expiresAt: .now.addingTimeInterval((expires_in ?? 3600) - 60))
        }
    }
    enum Failure: Error { case revoked, unavailable }
    static var clientID: String { Bundle.main.object(forInfoDictionaryKey: "GoogleClientID") as? String ?? "" }
    static func refreshKey(_ email: String) -> String { "google-refresh-token:\(email.lowercased())" }
    private static func accessKey(_ email: String) -> String { "google-access-token:\(email.lowercased())" }

    static func refresh(_ email: String, force: Bool = false) async throws -> Tokens {
        try await PushState.locked("oauth:" + email) {
            let refreshKey = refreshKey(email)
            guard let refreshToken = Keychain.get(refreshKey) else { throw Failure.revoked }
            if !force, let value = Keychain.get(accessKey(email)), let data = value.data(using: .utf8),
               let cached = try? JSONDecoder().decode(Tokens.self, from: data), cached.expiresAt > .now { return cached }
            let response: Response
            do {
                response = try await request(["grant_type": "refresh_token", "refresh_token": refreshToken])
            } catch Failure.revoked {
                // A sign-in could have replaced it while the request was in flight.
                if Keychain.get(refreshKey) == refreshToken { Keychain.set(refreshKey, nil) }
                throw Failure.revoked
            }
            try Task.checkCancellation()
            // Removal/replacement must never be undone by an in-flight refresh.
            guard Keychain.get(refreshKey) == refreshToken else { throw Failure.revoked }
            if let rotated = response.refresh_token { Keychain.set(refreshKey, rotated) }
            let tokens = response.tokens
            Keychain.set(accessKey(email), String(data: try JSONEncoder().encode(tokens), encoding: .utf8))
            return tokens
        }
    }

    static func forget(_ email: String) {
        Keychain.set(refreshKey(email), nil)
        Keychain.set(accessKey(email), nil)
        Keychain.removeLegacyGoogle(email)
    }

    static func request(_ params: [String: String]) async throws -> Response {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = form(params.merging(["client_id": clientID]) { a, _ in a })
        let (data, http) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(Response.self, from: data)
        if response.error == "invalid_grant" { throw Failure.revoked }
        guard (http as? HTTPURLResponse)?.statusCode == 200, response.access_token != nil, response.error == nil else { throw Failure.unavailable }
        return response
    }

    static func form(_ params: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return Data(params.map { "\($0)=\($1.addingPercentEncoding(withAllowedCharacters: allowed) ?? $1)" }.joined(separator: "&").utf8)
    }
}
