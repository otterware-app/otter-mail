import AuthenticationServices
import Foundation
import UIKit

/** The extra, limited provider consent is part of the mailbox setup on this phone. */
@MainActor
final class NotificationAuthorization: NSObject, ASWebAuthenticationPresentationContextProviding {
    func authorize(_ url: URL) async throws {
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme("ottermail-notifications")) { url, error in
                if let url { continuation.resume(returning: url) }
                else { continuation.resume(throwing: error ?? Relay.Failure(status: 0, message: "Notification setup was cancelled.")) }
            }
            session.presentationContextProvider = self
            session.start()
        }
        let result = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "result" }?.value
        guard result == "success" else { throw Relay.Failure(status: 0, message: "Notification setup didn't finish. Select the same mailbox and approve the limited access.") }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor(windowScene: scenes[0])
    }
}
