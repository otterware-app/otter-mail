import AuthenticationServices
import CryptoKit
import Foundation

/**
 * Microsoft sign-in for Outlook mailboxes (work, school and personal), as the
 * Mac app does it (docs/outlook.md): authorization code with PKCE in a
 * browser sheet, a public client (no secret), Microsoft returning to
 * `msauth.<bundle id>://auth`. Microsoft rotates refresh tokens: each refresh
 * keeps the new one in the Keychain, on this iPhone alone; a sign-in Microsoft
 * stops honoring is dropped. Access tokens stay in memory.
 */
@MainActor
final class MicrosoftAuth {
    /** Otter Mail's Microsoft app registration (not a secret; the relay knows it too). */
    static let clientID = "b0c4e8bf-e651-456e-9bc6-408a741b36f9"
    /** Microsoft's sign-in for every kind of account (contracts/src/microsoft.ts). */
    static let authority = "https://login.microsoftonline.com/common/oauth2/v2.0"
    /** OUTLOOK_SCOPES (contracts/src/microsoft.ts): mail, categories, the calendar, who you are, and a refresh token. */
    static let scopes = [
        "openid", "email", "profile", "offline_access",
        "https://graph.microsoft.com/User.Read",
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/MailboxSettings.ReadWrite",
        "https://graph.microsoft.com/Calendars.ReadWrite",
    ]

    struct Tokens {
        var accessToken: String
        var idToken: String?
        var expiresAt: Date
    }

    struct Profile {
        /** The mailbox's address, lowercased: its id everywhere. */
        var email: String
        var name: String?
    }

    enum Failure: LocalizedError {
        case cancelled
        /** Microsoft no longer honors the sign-in (revoked, expired, or consent needed): only signing in again helps. */
        case signedOut(String)
        case microsoft(String)

        var errorDescription: String? {
            switch self {
            case .cancelled: "Sign-in was cancelled."
            case .signedOut(let email): "\(email) needs to sign in to Microsoft again."
            case .microsoft(let message): message
            }
        }
    }

    private var tokens: [String: Tokens] = [:]
    private var refreshing: [String: Task<Tokens, Error>] = [:]
    private let presenter = Presenter()

    /** The redirect registered for this build's bundle id (iOS platform, in Azure). */
    private static var redirectScheme: String { "msauth.\(Bundle.main.bundleIdentifier ?? "dev.otterware.mail")" }
    private static var redirectURI: String { "\(redirectScheme)://auth" }
    private static func refreshKey(_ email: String) -> String { "microsoft-refresh-token:\(email.lowercased())" }

    func isSignedIn(_ email: String) -> Bool { Keychain.get(Self.refreshKey(email)) != nil }

    /** Opens Microsoft's sign-in; keeps the refresh token for the address it signed in. */
    func signIn(loginHint: String? = nil) async throws -> (profile: Profile, tokens: Tokens) {
        let verifier = Self.randomURLSafe(32)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let state = Self.randomURLSafe(16)
        var components = URLComponents(string: "\(Self.authority)/authorize")!
        components.queryItems = [
            .init(name: "client_id", value: Self.clientID),
            .init(name: "redirect_uri", value: Self.redirectURI),
            .init(name: "response_type", value: "code"),
            .init(name: "response_mode", value: "query"),
            .init(name: "scope", value: Self.scopes.joined(separator: " ")),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "state", value: state),
            .init(name: "prompt", value: "select_account"),
        ] + (loginHint.map { [.init(name: "login_hint", value: $0)] } ?? [])

        let callback = try await presenter.authenticate(url: components.url!, scheme: Self.redirectScheme)
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in query.first { $0.name == name }?.value }
        if value("error") == "access_denied" { throw Failure.cancelled }
        guard value("state") == state, let code = value("code") else {
            throw Failure.microsoft(value("error_description") ?? "Microsoft sign-in didn't finish.")
        }

        let response: Response
        do {
            response = try await Self.tokenRequest([
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": Self.redirectURI,
            ])
        } catch {
            throw Failure.microsoft("Couldn't reach Microsoft to complete sign-in. Try again.")
        }
        guard let refreshToken = response.refresh_token else {
            throw Failure.microsoft("Microsoft did not return a refresh token. Try again.")
        }
        let tokens = response.tokens
        let profile = try await Self.profile(accessToken: tokens.accessToken)
        guard Keychain.set(Self.refreshKey(profile.email), refreshToken, thisDeviceOnly: true) else {
            throw Failure.microsoft("Couldn't save the Microsoft sign-in on this iPhone.")
        }
        refreshing[profile.email]?.cancel()
        self.tokens[profile.email] = tokens
        return (profile, tokens)
    }

    /** A fresh access token for the mailbox (`force`: not the one Graph just refused). */
    func accessToken(_ email: String, force: Bool = false) async throws -> String {
        guard isSignedIn(email) else { throw Failure.signedOut(email) }
        if !force, let cached = tokens[email.lowercased()], cached.expiresAt > .now { return cached.accessToken }
        return try await refresh(email).accessToken
    }

    /** A fresh Microsoft ID token, the proof the relay asks for to link a mailbox. */
    func idToken(_ email: String) async throws -> String {
        if let cached = tokens[email.lowercased()], cached.expiresAt > .now, let id = cached.idToken { return id }
        guard let id = try await refresh(email).idToken else { throw Failure.microsoft("Microsoft didn't return an ID token.") }
        return id
    }

    /** Forgets the mailbox's sign-in here (Microsoft has no revocation for a single refresh token). */
    func forget(_ email: String) {
        let key = email.lowercased()
        refreshing[key]?.cancel()
        refreshing[key] = nil
        tokens[key] = nil
        Keychain.set(Self.refreshKey(email), nil)
    }

    private func refresh(_ email: String) async throws -> Tokens {
        let key = email.lowercased()
        if let running = refreshing[key] { return try await running.value }
        let task = Task { () throws -> Tokens in
            guard let saved = Keychain.get(Self.refreshKey(email)) else { throw Failure.signedOut(email) }
            let response: Response
            do {
                response = try await Self.tokenRequest(["grant_type": "refresh_token", "refresh_token": saved])
            } catch Failure.signedOut(_) {
                // Unless a new sign-in replaced it while the request was out.
                if Keychain.get(Self.refreshKey(email)) == saved { Keychain.set(Self.refreshKey(email), nil) }
                throw Failure.signedOut(email)
            }
            try Task.checkCancellation()
            // Forgotten or signed in again meanwhile: this answer is for a sign-in that's gone.
            guard Keychain.get(Self.refreshKey(email)) == saved else { throw Failure.signedOut(email) }
            if let rotated = response.refresh_token { Keychain.set(Self.refreshKey(email), rotated, thisDeviceOnly: true) }
            return response.tokens
        }
        refreshing[key] = task
        defer { if refreshing[key] == task { refreshing[key] = nil } }
        let fresh = try await task.value
        tokens[key] = fresh
        return fresh
    }

    // ── Microsoft's endpoints ────────────────────────────────────────────────

    private struct Response: Decodable {
        var access_token: String?
        var expires_in: Double?
        var refresh_token: String?
        var id_token: String?
        var error: String?

        var tokens: Tokens {
            Tokens(accessToken: access_token ?? "", idToken: id_token, expiresAt: .now.addingTimeInterval((expires_in ?? 3600) - 60))
        }
    }

    /** The token endpoint; a refused grant (revoked, expired, or new consent needed) is `signedOut`. */
    private static func tokenRequest(_ params: [String: String]) async throws -> Response {
        var request = URLRequest(url: URL(string: "\(authority)/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = GoogleCredentials.form(params.merging([
            "client_id": clientID,
            "scope": scopes.joined(separator: " "),
        ]) { a, _ in a })
        let (data, http) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(Response.self, from: data)
        if ["invalid_grant", "interaction_required", "consent_required", "login_required"].contains(response.error ?? "") {
            throw Failure.signedOut("")
        }
        guard (http as? HTTPURLResponse)?.statusCode == 200, response.access_token != nil else {
            throw Failure.microsoft("Microsoft refused the sign-in.")
        }
        return response
    }

    /** Who signed in: Graph's `mail`, else the sign-in name, as core's profile does. */
    private static func profile(accessToken: String) async throws -> Profile {
        struct Me: Decodable { var mail: String?; var userPrincipalName: String?; var displayName: String? }
        var request = URLRequest(url: URL(string: "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName")!)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let me = try? JSONDecoder().decode(Me.self, from: data),
              let email = [me.mail, me.userPrincipalName].compactMap({ $0 }).first(where: { $0.contains("@") }) else {
            throw Failure.microsoft("Couldn't read the Microsoft account's address.")
        }
        let name = me.displayName?.trimmingCharacters(in: .whitespaces)
        return Profile(email: email.lowercased(), name: name?.isEmpty == false ? name : nil)
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
                    continuation.resume(throwing: cancelled ? Failure.cancelled : Failure.microsoft(error?.localizedDescription ?? "Sign-in failed."))
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
