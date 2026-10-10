import AuthenticationServices
import CryptoKit
import Foundation

/**
 * Google sign-in, per mailbox, as the Mac app does it: the installed-app flow
 * (RFC 8252) with PKCE, in a browser sheet. The "iOS" OAuth client has no
 * secret and Google returns to its reversed id. Refresh tokens stay in the
 * Keychain and never leave the phone; access tokens are shared with the
 * notification extension on-device and renewed a minute before they expire.
 */
@MainActor
final class GoogleAuth {
    /**
     * The primary Google project's "iOS" client for this build's bundle ID (not a
     * secret; the relay lists it too), from Info.plist's GoogleClientID.
     */
    static let clientID = Bundle.main.object(forInfoDictionaryKey: "GoogleClientID") as? String ?? ""
    /**
     * Gmail, its settings (saving a signature) and who you are; no calendar or
     * contacts, which the iPhone app doesn't use. Sign-ins from before the
     * settings scope can't save signatures until signed in again.
     */
    static let scopes = [
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/gmail.settings.basic",
        "openid", "email", "profile",
    ]

    typealias Tokens = GoogleCredentials.Tokens

    struct Profile: Decodable {
        var email: String
        var name: String?
        var picture: String?
    }

    enum Failure: LocalizedError {
        case cancelled
        /** Google no longer honors the sign-in (revoked or expired): only signing in again helps. */
        case signedOut(String)
        case google(String)

        var errorDescription: String? {
            switch self {
            case .cancelled: "Sign-in was cancelled."
            case .signedOut(let email): "\(email) needs to sign in to Google again."
            case .google(let message): message
            }
        }
    }

    private var tokens: [String: Tokens] = [:]
    private var refreshing: [String: Task<Tokens, Error>] = [:]
    private var credentialVersions: [String: UUID] = [:]
    private let presenter = Presenter()

    private static var redirectScheme: String { clientID.split(separator: ".").reversed().joined(separator: ".") }
    private static var redirectURI: String { "\(redirectScheme):/oauth2redirect" }
    private static func refreshKey(_ email: String) -> String { "google-refresh-token:\(email.lowercased())" }

    func isSignedIn(_ email: String) -> Bool {
        Keychain.migrateGoogle(email)
        return Keychain.get(Self.refreshKey(email)) != nil
    }

    /** Opens Google's sign-in; keeps the refresh token for the address it signed in. */
    func signIn(loginHint: String? = nil) async throws -> (profile: Profile, tokens: Tokens) {
        let verifier = Self.randomURLSafe(32)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let state = Self.randomURLSafe(16)
        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            .init(name: "client_id", value: Self.clientID),
            .init(name: "redirect_uri", value: Self.redirectURI),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: Self.scopes.joined(separator: " ")),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "state", value: state),
            .init(name: "access_type", value: "offline"),
            .init(name: "prompt", value: "consent select_account"),
        ] + (loginHint.map { [.init(name: "login_hint", value: $0)] } ?? [])

        let callback = try await presenter.authenticate(url: components.url!, scheme: Self.redirectScheme)
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in query.first { $0.name == name }?.value }
        if value("error") == "access_denied" { throw Failure.cancelled }
        guard value("state") == state, let code = value("code") else {
            throw Failure.google(value("error") ?? "Google sign-in didn't finish.")
        }

        let response = try await Self.tokenRequest([
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": Self.redirectURI,
        ])
        guard let refreshToken = response.refresh_token else {
            throw Failure.google("Google did not return a refresh token. Try again.")
        }
        let tokens = response.tokens
        let profile = try await Self.profile(accessToken: tokens.accessToken)
        try await PushState.locked("oauth:" + profile.email) {
            guard GoogleCredentials.save(profile.email, credential: .init(refreshToken: refreshToken, clientID: Self.clientID)) else { throw Failure.google("Couldn't save the Google sign-in on this iPhone.") }
            credentialVersions[profile.email.lowercased()] = UUID()
        }
        self.tokens[profile.email.lowercased()] = tokens
        return (profile, tokens)
    }

    /** A fresh access token for the mailbox (`force`: not the one Gmail just refused). */
    func accessToken(_ email: String, force: Bool = false) async throws -> String {
        guard isSignedIn(email) else { throw Failure.signedOut(email) }
        if !force, let cached = tokens[email.lowercased()], cached.expiresAt > .now { return cached.accessToken }
        return try await refresh(email, force: force).accessToken
    }

    /** A fresh ID token, the proof the relay asks for to link a mailbox. */
    func idToken(_ email: String) async throws -> String {
        if let cached = tokens[email.lowercased()], cached.expiresAt > .now, let id = cached.idToken { return id }
        guard let id = try await refresh(email).idToken else { throw Failure.google("Google didn't return an ID token.") }
        return id
    }

    /**
     * Forgets the mailbox's sign-in on this iPhone. Google isn't asked to revoke it: revoking ends
     * the grant for every client in the Google Cloud project, signing the mailbox out on the
     * account's other devices and stopping the relay's background notifications.
     */
    @discardableResult
    func forget(_ email: String) -> Task<Void, Never> {
        let key = email.lowercased()
        let version = credentialVersions[key]
        refreshing[key]?.cancel()
        tokens[key] = nil
        // Deletion and refresh/rotation share the same cross-process lock. A later sign-in owns a new version.
        return Task {
            try? await PushState.locked("oauth:" + email) {
                guard credentialVersions[key] == version else { return }
                GoogleCredentials.forget(email)
            }
        }
    }

    func signOut(_ email: String) async {
        await forget(email).value
    }

    private func refresh(_ email: String, force: Bool = false) async throws -> Tokens {
        let key = email.lowercased()
        let version = credentialVersions[key]
        if let running = refreshing[key] { return try await running.value }
        let task = Task { () throws -> Tokens in
            guard isSignedIn(email) else { throw Failure.signedOut(email) }
            do {
                return try await GoogleCredentials.refresh(email, force: force)
            } catch GoogleCredentials.Failure.revoked {
                throw Failure.signedOut(email)
            }
        }
        refreshing[key] = task
        defer { refreshing[key] = nil }
        let fresh = try await task.value
        try Task.checkCancellation()
        guard credentialVersions[key] == version, isSignedIn(email) else { throw Failure.signedOut(email) }
        tokens[key] = fresh
        return fresh
    }

    // ── Google's endpoints ───────────────────────────────────────────────────

    private static func tokenRequest(_ params: [String: String]) async throws -> GoogleCredentials.Response {
        do { return try await GoogleCredentials.request(params) }
        catch GoogleCredentials.Failure.revoked { throw Failure.google("Google sign-in expired. Try again.") }
        catch { throw Failure.google("Couldn't reach Google to complete sign-in. Try again.") }
    }

    private static func profile(accessToken: String) async throws -> Profile {
        var request = URLRequest(url: URL(string: "https://www.googleapis.com/oauth2/v3/userinfo")!)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw Failure.google("Couldn't read the Google profile.")
        }
        return try JSONDecoder().decode(Profile.self, from: data)
    }

    private static func form(_ params: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return Data(params.map { "\($0)=\($1.addingPercentEncoding(withAllowedCharacters: allowed) ?? $1)" }
            .joined(separator: "&").utf8)
    }

    private static func randomURLSafe(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes).base64URL
    }

    /** Runs the browser sheet over the app's window. */
    private final class Presenter: NSObject, ASWebAuthenticationPresentationContextProviding {
        func authenticate(url: URL, scheme: String) async throws -> URL {
            try await withCheckedThrowingContinuation { continuation in
                let session = ASWebAuthenticationSession(url: url, callback: .customScheme(scheme)) { url, error in
                    if let url { return continuation.resume(returning: url) }
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    continuation.resume(throwing: cancelled ? Failure.cancelled : Failure.google(error?.localizedDescription ?? "Sign-in failed."))
                }
                session.presentationContextProvider = self
                session.start()
            }
        }

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor(windowScene: scenes[0])
        }
    }
}

nonisolated extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init?(base64URL: String) {
        var s = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        self.init(base64Encoded: s)
    }
}
