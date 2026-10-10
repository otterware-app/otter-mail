import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private var work: Task<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var completion: NotificationCompletion<UNNotificationContent>?
    private var fallback: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        serviceExtensionTimeWillExpire()
        let gate = NotificationCompletion(contentHandler)
        completion = gate
        fallback = request.content
        if let info = request.content.userInfo["otter"] as? [String: Any], info["version"] as? Int == 2 {
            enrichVerified(request.content, metadata: info, gate: gate)
            return
        }
        gate.finish(request.content)
    }

    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        timeout?.cancel()
        if let fallback { completion?.finish(fallback) }
    }

    private func enrichVerified(_ fallback: UNNotificationContent, metadata: [String: Any], gate: NotificationCompletion<UNNotificationContent>) {
        guard let data = try? JSONSerialization.data(withJSONObject: metadata),
              let event = try? JSONDecoder().decode(VerifiedNotification.Metadata.self, from: data),
              PushState.permits(userId: event.userId, email: event.email) else { gate.finish(fallback); return }
        let original = NotificationOriginal(fallback)
        work = Task {
            do {
                try await PushState.locked("notification:" + event.email) {
                    guard let config = PushState.configuration(), config.userId == event.userId else { gate.finish(original.content); return }
                    let message = try await VerifiedNotification.enrich(event, configuration: config)
                    try Task.checkCancellation()
                    guard PushState.configuration() == config else { gate.finish(original.content); return }
                    let content = original.content.mutableCopy() as! UNMutableNotificationContent
                    if let message {
                        content.title = String(message.sender.prefix(200))
                        if content.title.isEmpty { content.title = "New mail" }
                        content.subtitle = String(message.subject.prefix(300))
                        content.body = String(message.preview.prefix(500))
                        content.sound = .default
                        content.threadIdentifier = event.email + ":" + (message.threadId ?? message.id)
                        content.userInfo["mailbox"] = event.email
                        content.userInfo["message"] = message.id
                        if let thread = message.threadId { content.userInfo["thread"] = thread }
                    }
                    gate.finish(content)
                }
            } catch { gate.finish(original.content) }
        }
        let running = work
        timeout = Task {
            do { try await Task.sleep(for: .seconds(22)) } catch { return }
            running?.cancel()
            gate.finish(original.content)
        }
    }
}

/** The received content is immutable; only its copy is changed by the enrichment task. */
private final class NotificationOriginal: @unchecked Sendable {
    let content: UNNotificationContent
    init(_ content: UNNotificationContent) { self.content = content }
}
