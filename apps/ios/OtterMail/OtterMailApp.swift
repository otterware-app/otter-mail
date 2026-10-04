import BackgroundTasks
import SwiftUI
import UserNotifications

/**
 * Otter Mail for iPhone. The Mac and web apps are one TypeScript app
 * (apps/desktop, apps/web); this is its native sibling, with the same
 * Otter account, mailboxes, themes and settings.
 */
@main
struct OtterMailApp: App {
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var preferences: Preferences
    @State private var session: Session

    static let refreshTask = "dev.otterware.mail.refresh"

    init() {
        let preferences = Preferences()
        _preferences = State(initialValue: preferences)
        _session = State(initialValue: Session(preferences: preferences))
    }

    var body: some Scene {
        WindowGroup {
            Themed {
                switch session.state {
                case .welcome: WelcomeView()
                case .demo, .signedIn: HomeView()
                }
            }
            .environment(preferences)
            .environment(session)
            .environment(session.store)
            .onAppear { delegate.session = session }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await session.relay.retrySignOuts(); await session.refreshAccount() }
            case .background:
                session.disconnect()
                Task { await Self.scheduleRefresh() }
            default: break
            }
        }
        .backgroundTask(.appRefresh(Self.refreshTask)) {
            await Self.scheduleRefresh()
            await session.backgroundRefresh()
        }
    }

    /** Checks Gmail every so often while the app is away (iOS picks the moment). */
    private static func scheduleRefresh() async {
        let request = BGAppRefreshTaskRequest(identifier: refreshTask)
        request.earliestBeginDate = .now.addingTimeInterval(15 * 60)
        // Xcode 27 (Swift 6.4) has the async form; CI's Xcode 26 doesn't yet.
        #if compiler(>=6.4)
        if #available(iOS 27, *) {
            try? await BGTaskScheduler.shared.submitTaskRequest(request)
            return
        }
        #endif
        try? BGTaskScheduler.shared.submit(request)
    }
}

/** Opens the thread a notification is about. */
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var session: Session? {
        didSet {
            if let tapped { session?.opening = tapped; self.tapped = nil }
            if let token { session?.registeredForPush(token) }
        }
    }
    /** A tap that launched the app, held until the window hands over the session. */
    private var tapped: Session.NotificationDestination?
    private var token: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        self.token = token
        session?.registeredForPush(token)
    }

    // The completion-handler forms, called on the main thread: the async forms' thunks
    // call UIKit's completion handler from a background thread, which crashes on a tap.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let metadata = info["otter"] as? [String: Any]
        let destination = Session.NotificationDestination(userId: metadata?["userId"] as? String,
            email: (info["mailbox"] as? String) ?? (metadata?["email"] as? String), thread: info["thread"] as? String)
        if let session { session.opening = destination } else { tapped = destination }
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let info = notification.request.content.userInfo
        if let metadata = info["otter"] as? [String: Any] {
            let userId = metadata["userId"] as? String
            let email = metadata["email"] as? String ?? ""
            // Foreground suppression is supported. A change marker alone doesn't merit a new-mail banner.
            let show = session?.user?.id == userId && info["message"] != nil && session?.preferences.notifications != .off
                && PushState.permits(userId: userId ?? "", email: email)
            completionHandler(show ? [.banner, .sound] : [])
            Task { await session?.backgroundRefresh() }
        } else {
            completionHandler(session?.preferences.notifications == .off ? [] : [.banner, .sound])
        }
    }
}

/** Paints its content with the theme picked for the current appearance. */
struct Themed<Content: View>: View {
    @Environment(Preferences.self) private var preferences
    @ViewBuilder var content: Content

    var body: some View {
        ThemedContent(content: content)
            .preferredColorScheme(preferences.scheme.colorScheme)
    }

    private struct ThemedContent: View {
        @Environment(Preferences.self) private var preferences
        @Environment(\.colorScheme) private var colorScheme
        let content: Content

        var body: some View {
            let id = colorScheme == .dark ? preferences.darkTheme : preferences.lightTheme
            let palette = (preferences.theme(id) ?? Theme.named(Preferences.initialTheme))?.palette(colorScheme)
            content
                .environment(\.palette, palette ?? EnvironmentValues().palette)
                .tint(palette?.action)
                // Switches wear the focus color, as on the desktop (a monochrome action would vanish).
                .toggleStyle(SwitchToggleStyle(tint: palette?.focus ?? .blue))
        }
    }
}

extension Preferences.Scheme {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
