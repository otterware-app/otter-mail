import Foundation
import Observation
import UserNotifications
import UIKit

/**
 * Who's using the app and with which mail: the demo, or an Otter account
 * with its mailboxes. Signed in, it follows the account the way core does
 * on the Mac (otter-account.ts, linked-accounts.ts, preferences.ts,
 * realtime.ts): mailboxes linked on any device show up here, preferences
 * sync both ways, and the relay's events trigger syncs.
 */
@Observable
final class Session {
    enum State: Equatable {
        case welcome
        case demo
        case signedIn(Relay.User)
    }

    private(set) var state: State
    private(set) var store: MailStore
    /** Set while a sign-in sheet or first sync is running, with what it's doing. */
    private(set) var busy: String?
    private(set) var notificationConnections: [String: Relay.NotificationConnection] = [:]
    private(set) var notificationProviders: Set<String> = []
    @ObservationIgnored private let notificationAuthorization = NotificationAuthorization()
    /** A thread to open (from a notification). */
    var opening: NotificationDestination?

    struct NotificationDestination: Equatable {
        var userId: String?
        var email: String?
        var thread: String?
        var message: String? = nil
    }

    let preferences: Preferences
    let agent = Agent()
    @ObservationIgnored let relay = Relay()
    @ObservationIgnored let google = GoogleAuth()
    @ObservationIgnored let microsoft = MicrosoftAuth()
    @ObservationIgnored private var sync: MailSync?
    @ObservationIgnored private var pushTopic: String?
    @ObservationIgnored private var refreshing: Task<Void, Never>?
    /** The account's `ui` and `settings` sections as last seen, so writes keep the keys only other apps have. */
    @ObservationIgnored private var remoteSections: [String: [String: Any]] = [:]
    @ObservationIgnored private var pushingPreferences: Task<Void, Never>?
    @ObservationIgnored private var pushingRegistration: Task<Void, Never>?
    @ObservationIgnored private var registeringPush = false
    @ObservationIgnored private var apnsToken: String? = UserDefaults.standard.string(forKey: "apns:token")

    private static let userKey = "otter:user"
    private static let demoKey = "otter:demo"

    init(preferences: Preferences) {
        self.preferences = preferences
        if relay.isSignedIn, let data = UserDefaults.standard.data(forKey: Self.userKey),
           let user = try? JSONDecoder().decode(Relay.User.self, from: data) {
            state = .signedIn(user)
            store = MailStore(preferences: preferences)
        } else if UserDefaults.standard.bool(forKey: Self.demoKey) {
            state = .demo
            store = .demo(preferences: preferences)
        } else {
            state = .welcome
            store = MailStore(preferences: preferences)
        }
        relay.onSignedOut = { [weak self] in self?.endSession() }
        preferences.onChange = { [weak self] section in self?.preferenceChanged(section) }
        agent.onChange = { [weak self] section in self?.preferenceChanged(section) }
        agent.relay = relay
        agent.mailStore = { [weak self] in self?.store }
        Task { [agent] in await agent.check() }
        if case .signedIn = state { startLive() } else { PushState.configure(nil) }
    }

    var user: Relay.User? {
        if case .signedIn(let user) = state { user } else { nil }
    }

    // ── Starting ─────────────────────────────────────────────────────────────

    func tryDemo() {
        PushState.configure(nil)
        UserDefaults.standard.set(true, forKey: Self.demoKey)
        store = .demo(preferences: preferences)
        state = .demo
    }

    /** "Sign in with Google": the Otter account, and that Google account as its first mailbox. */
    func signIn() async throws {
        busy = "Signing in…"
        defer { busy = nil }
        let (profile, tokens) = try await google.signIn()
        guard let idToken = tokens.idToken else { throw GoogleAuth.Failure.google("Google didn't return an ID token.") }
        let user = try await relay.signIn(idToken: idToken)
        UserDefaults.standard.set(try? JSONEncoder().encode(user), forKey: Self.userKey)
        UserDefaults.standard.set(false, forKey: Self.demoKey)
        store = MailStore(preferences: preferences)
        state = .signedIn(user)
        startLive()
        try await link(profile, idToken: idToken)
        busy = "Loading your mail…"
        await refreshAccount()
        await offerNotifications(profile.email)
    }

    private func startLive() {
        if let user { store.configureRecovery(namespace: Data(user.id.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_")) }
        let sync = MailSync(store: store, google: google, microsoft: microsoft, relay: relay)
        self.sync = sync
        store.sync = sync
        let cached = (try? JSONDecoder().decode([Mailbox].self, from: UserDefaults.standard.data(forKey: "otter:mailboxes") ?? Data())) ?? []
        for mailbox in cached { store.upsert(mailbox: mailbox) }
        sync.loadCache(for: cached.map(\.email))
        if let user { sync.pushMailboxes = Set(UserDefaults.standard.stringArray(forKey: "push:mailboxes:" + user.id) ?? []) }
        configurePush()
        Task { await refreshAccount() }
    }

    /** Everything from the relay, then mail from the mailboxes' servers: on launch, and when the app comes back. */
    func refreshAccount() async {
        if let refreshing { return await refreshing.value }
        guard case .signedIn = state, let currentSync = sync else { return }
        let task = Task {
            await currentSync.waitForCache()
            guard !Task.isCancelled, sync === currentSync else { return }
            async let preferences: Void = pullPreferences()
            async let accounts: Void = pullAccounts()
            _ = await (preferences, accounts)
            guard !Task.isCancelled, sync === currentSync else { return }
            if pushTopic == nil { pushTopic = try? await relay.me().pushTopic }
            guard !Task.isCancelled, sync === currentSync else { return }
            connect()
            await currentSync.syncAll()
            guard !Task.isCancelled, sync === currentSync else { return }
            await currentSync.watch(pushTopic: pushTopic)
            await refreshNotificationConnections()
            await updatePushRegistration()
            await requestNotifications()
            await updateBadge()
        }
        refreshing = task
        await task.value
        // A newer session may already be refreshing after sign-out.
        if sync === currentSync { refreshing = nil }
    }

    /** Listens to the relay while the app is open. */
    func connect() {
        relay.connect { [weak self] event in
            guard let self else { return }
            Task {
                switch event {
                case .mail(let email):
                    if let mailbox = self.store.mailboxes.first(where: { $0.email.lowercased() == email }) {
                        await self.sync?.sync(mailbox.email, notify: true)
                        await self.updateBadge()
                    }
                case .accounts: await self.pullAccounts()
                case .preferences: await self.pullPreferences()
                }
            }
        }
    }

    /** The app went to the background: the relay's events and IMAP's IDLE stop. */
    func disconnect() {
        store.commitPendingAction()
        relay.disconnect()
        sync?.stopWatching()
    }

    /** A background refresh: catch up and say what's new. */
    func backgroundRefresh() async {
        guard case .signedIn = state else { return }
        if let account = try? await relay.me() { pushTopic = account.pushTopic }
        guard case .signedIn = state else { return }
        await pullAccounts()
        await pullPreferences()
        guard case .signedIn = state else { return }
        await sync?.syncAll(notify: true)
        await sync?.watch(pushTopic: pushTopic, relayOnly: true)
        await updatePushRegistration()
        await updateBadge()
    }

    // ── Mailboxes ────────────────────────────────────────────────────────────

    /** Signs in to another Google account and links it to the Otter account. */
    func addMailbox() async throws {
        busy = "Adding the mailbox…"
        defer { busy = nil }
        let (profile, tokens) = try await google.signIn()
        guard let idToken = tokens.idToken else { throw GoogleAuth.Failure.google("Google didn't return an ID token.") }
        try await link(profile, idToken: idToken)
        await sync?.sync(profile.email)
        await offerNotifications(profile.email)
    }

    /** Signs in to Google (or Microsoft, for Outlook) for a mailbox linked on another device (or whose sign-in lapsed). */
    func signIn(mailbox email: String) async throws {
        busy = "Signing in…"
        defer { busy = nil }
        if store.mailbox(email)?.provider == .outlook {
            let (profile, _) = try await microsoft.signIn(loginHint: email)
            guard profile.email == email.lowercased() else {
                // Not a mailbox here: its sign-in has no use.
                if store.mailbox(profile.email) == nil { microsoft.forget(profile.email) }
                throw MicrosoftAuth.Failure.microsoft("That's \(profile.email). Sign in as \(email).")
            }
        } else {
            let (profile, _) = try await google.signIn(loginHint: email)
            guard profile.email.lowercased() == email.lowercased() else {
                await google.signOut(profile.email)
                throw GoogleAuth.Failure.google("That's \(profile.email). Sign in as \(email).")
            }
        }
        store.setSignedOut(false, email)
        saveMailboxes()
        await sync?.sync(email)
        await sync?.watch(pushTopic: pushTopic)
    }

    /**
     * Signs in to an Outlook mailbox (Microsoft 365, or outlook.com and the
     * like) and links it to the Otter account with Microsoft's ID token.
     */
    func addOutlookMailbox() async throws {
        busy = "Adding the mailbox…"
        defer { busy = nil }
        let (profile, tokens) = try await microsoft.signIn()
        guard let idToken = tokens.idToken else { throw MicrosoftAuth.Failure.microsoft("Microsoft didn't return an ID token.") }
        let existing = store.mailbox(profile.email)
        store.upsert(mailbox: Mailbox(
            email: profile.email,
            name: profile.name ?? profile.email,
            displayName: existing?.displayName ?? profile.name ?? profile.email,
            color: existing?.color ?? Self.defaultColor(profile.email),
            // Outlook's signature follows the Otter account, as IMAP's does.
            signature: existing?.signature ?? remoteSignatures[profile.email] ?? "",
            labels: existing?.labels ?? [],
            outlook: true
        ))
        saveMailboxes()
        try await relay.putAccount(profile.email, idToken: idToken, profile: .init(
            email: profile.email, provider: .outlook, name: profile.name,
            displayName: existing?.displayName, color: existing?.color
        ))
        busy = "Loading your mail…"
        await sync?.sync(profile.email)
        await sync?.watch(pushTopic: pushTopic)
        await offerNotifications(profile.email)
    }

    /**
     * Adds an IMAP mailbox: checks the settings by logging in, keeps the
     * password in the Keychain (never synced), and links the mailbox with its
     * settings so it follows the Otter account (other devices ask for the
     * password once).
     */
    func addImapMailbox(_ email: String, settings: ImapSettings, password: String) async throws {
        busy = "Checking…"
        defer { busy = nil }
        try await ImapProvider.verify(settings, password: password)
        busy = "Adding the mailbox…"
        let existing = store.mailbox(email)
        // IMAP says nothing of who's there: the address stands for the name until it's set in Settings.
        let name = existing?.name ?? ""
        try await relay.putAccount(email, profile: .init(
            email: email, imap: settings, displayName: existing?.displayName, color: existing?.color
        ))
        ImapProvider.setPassword(password, for: email)
        store.upsert(mailbox: Mailbox(
            email: email,
            name: name,
            displayName: existing?.displayName ?? email,
            color: existing?.color ?? Self.defaultColor(email),
            signature: existing?.signature ?? "",
            labels: existing?.labels ?? [],
            imap: settings
        ))
        saveMailboxes()
        busy = "Loading your mail…"
        await sync?.sync(email)
        await sync?.watch(pushTopic: pushTopic)
    }

    /** Enters the password for an IMAP mailbox linked on another device (or whose password changed). */
    func signIn(mailbox email: String, password: String) async throws {
        guard let settings = store.mailbox(email)?.imap else { return }
        busy = "Signing in…"
        defer { busy = nil }
        try await ImapProvider.verify(settings, password: password)
        ImapProvider.setPassword(password, for: email)
        store.setSignedOut(false, email)
        saveMailboxes()
        await sync?.sync(email)
        await sync?.watch(pushTopic: pushTopic)
    }

    private func link(_ profile: GoogleAuth.Profile, idToken: String) async throws {
        let existing = store.mailbox(profile.email)
        let mailbox = Mailbox(
            email: profile.email,
            name: profile.name ?? profile.email,
            displayName: existing?.displayName ?? profile.name ?? profile.email,
            color: existing?.color ?? Self.defaultColor(profile.email),
            signature: existing?.signature ?? "",
            labels: existing?.labels ?? [],
            picture: profile.picture
        )
        store.upsert(mailbox: mailbox)
        saveMailboxes()
        try await relay.putAccount(profile.email, idToken: idToken, profile: .init(
            email: profile.email, name: profile.name, picture: profile.picture,
            displayName: existing?.displayName, color: existing?.color
        ))
    }

    /** A mailbox's name and color, here and on every device. */
    func update(_ mailbox: Mailbox) {
        store.upsert(mailbox: mailbox)
        saveMailboxes()
        guard !store.isDemo else { return }
        Task {
            // Not the name and picture: the devices signed in to Google send those, and ours may be older.
            try? await relay.putAccount(mailbox.email, profile: .init(
                email: mailbox.email, displayName: mailbox.displayName, color: mailbox.color
            ))
        }
    }

    /** Saves the signature in Gmail, or here and on the Otter account for IMAP and Outlook (the demo just keeps it). */
    func setSignature(_ html: String, for email: String) async throws {
        if let sync {
            try await sync.setSignature(html, for: email)
            if store.mailbox(email)?.capabilities.serverSignatures == false {
                saveMailboxes()
                preferenceChanged("signatures")
            }
        } else if var mailbox = store.mailbox(email) {
            mailbox.signature = html
            store.upsert(mailbox: mailbox)
        }
    }

    /** Removes the mailbox from the Otter account (every device) and signs it out here. */
    func remove(_ mailbox: Mailbox) async {
        store.remove(mailbox: mailbox.email)
        saveMailboxes()
        guard !store.isDemo else { return }
        sync?.forget(mailbox.email)
        await signOut(mailbox)
        try? await relay.unlink(mailbox.email)
    }

    /** Forgets the mailbox's sign-in here: Google's (and asks Google to end it), Microsoft's, or the IMAP password. */
    private func signOut(_ mailbox: Mailbox) async {
        let userId = user?.id
        let revocation = mailbox.provider == .gmail ? google.forget(mailbox.email) : nil
        if mailbox.provider == .imap { ImapProvider.setPassword(nil, for: mailbox.email) }
        if mailbox.provider == .outlook { microsoft.forget(mailbox.email) }
        configurePush()
        if let userId {
            try? await PushState.locked("notification:" + mailbox.email) {
                if PushState.cursor(mailbox.email)?.userId == userId { try PushState.save(nil, email: mailbox.email) }
            }
        }
        if let revocation { await google.revoke(await revocation.value) }
    }

    private func pullAccounts() async {
        guard let userId = user?.id else { return }
        guard let accounts = try? await relay.accounts() else { return }
        guard user?.id == userId else { return }
        let linked = Set(accounts.map { $0.email.lowercased() })
        for account in accounts {
            let existing = store.mailbox(account.email)
            let imap = account.provider == .imap ? account.imap : nil
            let outlook = account.provider == .outlook
            if let before = existing?.imap, let imap, Self.hosts(before) != Self.hosts(imap) {
                // Moved to other servers on another device: the password isn't sent there until it's entered again for them.
                ImapProvider.setPassword(nil, for: account.email)
                sync?.stop(account.email)
            }
            store.upsert(mailbox: Mailbox(
                email: account.email,
                name: account.name ?? (imap == nil ? account.email : ""),
                displayName: account.displayName ?? account.name ?? account.email,
                color: account.color ?? Self.defaultColor(account.email),
                // New here: an IMAP or Outlook mailbox's signature as the account keeps it.
                signature: existing?.signature ?? (imap == nil && !outlook ? "" : remoteSignatures[account.email.lowercased()] ?? ""),
                labels: existing?.labels ?? [],
                picture: account.picture,
                signedOut: imap != nil ? ImapProvider.password(account.email) == nil
                    : outlook ? !microsoft.isSignedIn(account.email) : !google.isSignedIn(account.email),
                imap: imap,
                outlook: outlook ? true : nil
            ))
        }
        // Unlinked on another device: gone here too.
        for mailbox in store.mailboxes where !linked.contains(mailbox.email.lowercased()) {
            store.remove(mailbox: mailbox.email)
            sync?.forget(mailbox.email)
            await signOut(mailbox)
            guard user?.id == userId else { return }
        }
        saveMailboxes()
    }

    private static func hosts(_ settings: ImapSettings) -> [String] {
        [settings.imap.host.lowercased(), settings.smtp.host.lowercased()]
    }

    private func saveMailboxes() {
        guard !store.isDemo else { return }
        UserDefaults.standard.set(try? JSONEncoder().encode(store.mailboxes), forKey: "otter:mailboxes")
        configurePush()
    }

    /** The desktop's fallback color for a mailbox without one (account-style.ts). */
    static func defaultColor(_ email: String) -> String {
        let palette = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#007aff", "#5856d6", "#af52de", "#ff2d55", "#a2845e"]
        var hash: Int32 = 0
        for unit in email.utf16 { hash = hash &* 31 &+ Int32(unit) }
        return palette[Int(hash.magnitude) % palette.count]
    }

    // ── Preferences ──────────────────────────────────────────────────────────

    private func pullPreferences() async {
        guard let userId = user?.id else { return }
        guard let (sections, hermesKey) = try? await relay.preferences() else { return }
        guard user?.id == userId else { return }
        let ui = sections["ui"] as? [String: Any]
        let settings = sections["settings"] as? [String: Any]
        remoteSections["ui"] = ui ?? [:]
        remoteSections["settings"] = settings ?? [:]
        let pendingMode = UserDefaults.standard.string(forKey: "push:pending-mode:" + userId)
        var appliedSettings = settings ?? [:]
        if let pendingMode { appliedSettings["notificationsMode"] = pendingMode }
        preferences.apply(ui: ui ?? [:], settings: appliedSettings)
        configurePush()
        if let pendingMode {
            let remoteMode = settings?["notificationsMode"] as? String
            if remoteMode == pendingMode {
                UserDefaults.standard.removeObject(forKey: "push:pending-mode:" + userId)
            } else { preferenceChanged("settings") }
        }
        agent.apply(section: sections["assistant"] as? [String: Any], key: hermesKey)
        let signatures = sections["signatures"] as? [String: String]
        remoteSections["signatures"] = signatures ?? [:]
        applySignatures()
        // A section the account doesn't have yet is seeded from here, as core does.
        if ui == nil { preferenceChanged("ui") }
        if settings == nil { preferenceChanged("settings") }
        if signatures == nil { preferenceChanged("signatures") }
    }

    /** The account's IMAP signatures (by lower-cased address), as last pulled or written. */
    private var remoteSignatures: [String: String] {
        (remoteSections["signatures"] as? [String: String]) ?? [:]
    }

    /** IMAP servers keep no signatures: the account's (core's `signatures` section) are theirs. */
    private func applySignatures() {
        var changed = false
        for var mailbox in store.mailboxes where !mailbox.capabilities.serverSignatures {
            guard let signature = remoteSignatures[mailbox.email.lowercased()], signature != mailbox.signature else { continue }
            mailbox.signature = signature
            store.upsert(mailbox: mailbox)
            changed = true
        }
        if changed { saveMailboxes() }
    }

    /** This device's IMAP signatures, written over the account's; mailboxes it doesn't have keep theirs. */
    private var signaturesSection: [String: Any] {
        Dictionary(store.mailboxes.filter { !$0.capabilities.serverSignatures }.map { ($0.email.lowercased(), $0.signature) }) { a, _ in a }
    }

    private func preferenceChanged(_ section: String) {
        guard let userId = user?.id else { return }
        if section == "settings" {
            UserDefaults.standard.set(preferences.notifications.rawValue, forKey: "push:pending-mode:" + userId)
        }
        configurePush()
        if preferences.notifications == .off { Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) } }
        if section == "hermesKey" {
            let key = agent.key
            Task { try? await relay.putPreferences(["assistant": agent.syncedSection], hermesKey: .some(key)) }
            return
        }
        if section == "assistant" {
            Task { try? await relay.putPreferences(["assistant": agent.syncedSection]) }
            return
        }
        // Not pulled yet: writing now would drop the other devices' signatures.
        if section == "signatures", remoteSections["signatures"] == nil { return }
        let ours: [String: Any] = switch section {
        case "ui": preferences.uiSection
        case "signatures": signaturesSection
        default: preferences.settingsSection
        }
        let merged = (remoteSections[section] ?? [:]).merging(ours) { _, mine in mine }
        remoteSections[section] = merged
        pushingPreferences?.cancel()
        pushingPreferences = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, user?.id == userId else { return }
            let sections = remoteSections.mapValues { $0 }
            do {
                try await relay.putPreferences(sections)
                let key = "push:pending-mode:" + userId
                let sentMode = sections["settings"]?["notificationsMode"] as? String
                if user?.id == userId, UserDefaults.standard.string(forKey: key) == sentMode {
                    UserDefaults.standard.removeObject(forKey: key)
                }
            } catch { /* Keep a pending notification mode until the next account refresh. */ }
        }
    }

    // ── Devices and signing out ──────────────────────────────────────────────

    func signOut() async {
        endSession()
        await relay.signOut()
    }

    func deleteAccount() async throws {
        try await relay.deleteUser()
        endSession()
    }

    /** Back to the welcome screen, with nothing of the account left here. */
    private func endSession() {
        notificationConnections = [:]
        notificationProviders = []
        let previousUser = user
        PushState.configure(nil)
        pushingRegistration?.cancel()
        pushingRegistration = nil
        pushingPreferences?.cancel()
        pushingPreferences = nil
        remoteSections = [:]
        pushTopic = nil
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        refreshing?.cancel()
        refreshing = nil
        store.commitPendingAction()
        store.clearRecovery()
        let mailboxes = store.mailboxes
        relay.disconnect()
        sync?.forgetAll()
        sync = nil
        let revocations = mailboxes.filter { $0.provider == .gmail }.map { google.forget($0.email) }
        for mailbox in mailboxes where mailbox.provider == .imap { ImapProvider.setPassword(nil, for: mailbox.email) }
        for mailbox in mailboxes where mailbox.provider == .outlook { microsoft.forget(mailbox.email) }
        Task {
            for mailbox in mailboxes {
                try? await PushState.locked("notification:" + mailbox.email) {
                    if PushState.cursor(mailbox.email)?.userId == previousUser?.id { try PushState.save(nil, email: mailbox.email) }
                }
            }
            for revocation in revocations { await google.revoke(await revocation.value) }
        }
        if let previousUser {
            UserDefaults.standard.removeObject(forKey: "push:mailboxes:" + previousUser.id)
            UserDefaults.standard.removeObject(forKey: "push:pending-mode:" + previousUser.id)
        }
        UserDefaults.standard.removeObject(forKey: Self.userKey)
        UserDefaults.standard.removeObject(forKey: "otter:mailboxes")
        UserDefaults.standard.set(false, forKey: Self.demoKey)
        store = MailStore(preferences: preferences)
        state = .welcome
        agent.newChat()
        agent.forgetKey()
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) }
    }

    /** The demo ends the same way. */
    func leaveDemo() {
        store.commitPendingAction()
        store.clearRecovery()
        UserDefaults.standard.set(false, forKey: Self.demoKey)
        store = MailStore(preferences: preferences)
        state = .welcome
    }

    // ── The app icon ─────────────────────────────────────────────────────────

    /** Unread in the inbox, on the icon (the Dock badge on the Mac). */
    private func updateBadge() async {
        guard preferences.notifications != .off else { return }
        try? await UNUserNotificationCenter.current().setBadgeCount(store.unreadCount(in: .inbox, scope: nil))
    }

    /** Asks once to show notifications (when they're on in Settings). */
    func requestNotifications() async {
        guard preferences.notifications != .off else { return }
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        guard user != nil else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func registeredForPush(_ token: String) {
        apnsToken = token
        UserDefaults.standard.set(token, forKey: "apns:token")
        configurePush()
    }

    /** Local preference/access changes take effect immediately, even when the relay is offline. */
    private func configurePush() {
        guard let user else { PushState.configure(nil); return }
        let available = store.shownMailboxes.filter { mailbox in
            guard !mailbox.signedOut else { return false }
            guard ["ready", "retry"].contains(notificationConnections[mailbox.email.lowercased()]?.status ?? "") else { return false }
            switch mailbox.provider {
            case .gmail: return google.isSignedIn(mailbox.email)
            case .outlook: return microsoft.isSignedIn(mailbox.email)
            case .imap: return ImapProvider.password(mailbox.email) != nil
            }
        }
        let emails = available.map { $0.email.lowercased() }
        let settings = Dictionary(uniqueKeysWithValues: available.compactMap { mailbox in mailbox.imap.map { (mailbox.email.lowercased(), $0) } })
        PushState.configure(.init(userId: user.id, mode: preferences.notifications.rawValue, mailboxes: emails, imapSettings: settings))
        if pushingRegistration == nil {
            pushingRegistration = Task {
                await updatePushRegistration()
                pushingRegistration = nil
            }
        }
    }

    private func updatePushRegistration() async {
        guard !registeringPush else { return }
        registeringPush = true
        defer { registeringPush = false }
        while !Task.isCancelled, let token = apnsToken, let config = PushState.configuration(), user?.id == config.userId {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            let enabled = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional || settings.authorizationStatus == .ephemeral
            do {
                try await relay.registerPush(token: token, mode: enabled ? config.mode : "off", mailboxes: config.mailboxes)
                guard !Task.isCancelled, user?.id == config.userId else { return }
                if PushState.configuration() != config || apnsToken != token { continue }
                let emails = enabled && config.mode != "off" ? config.mailboxes : []
                sync?.pushMailboxes = Set(emails)
                UserDefaults.standard.set(emails, forKey: "push:mailboxes:" + config.userId)
            } catch { /* Retry on the next lifecycle/preference/token change. */ }
            return
        }
    }

    /** A generic tap opens the mailbox; an enriched tap can fetch a thread absent from the cache. */
    func prepareNotification(_ destination: NotificationDestination) async {
        let originalUser = user?.id
        guard destination.userId == nil || destination.userId == user?.id else { opening = nil; return }
        await refreshAccount()
        guard let email = destination.email ?? destination.thread.flatMap({ store.thread($0)?.mailbox }),
              let mailbox = store.mailboxes.first(where: { $0.email.lowercased() == email.lowercased() }), !mailbox.signedOut else { return }
        await sync?.sync(mailbox.email)
        if let message = destination.message, let id = ImapID(message), mailbox.imap != nil,
           !store.threads.contains(where: { $0.mailbox == mailbox.email && $0.messages.contains(where: { $0.id == message }) }) {
            await sync?.loadMore(.label(id.path, id.path), scope: mailbox.email)
        }
        if let message = destination.message, destination.thread == nil,
           let thread = store.threads.first(where: { $0.mailbox.lowercased() == mailbox.email.lowercased() && $0.messages.contains(where: { $0.id == message }) }) {
            opening?.thread = thread.id
        }
        if let thread = destination.thread, mailbox.provider == .gmail, store.thread(thread)?.mailbox.lowercased() != mailbox.email.lowercased() {
            let api = GmailAPI(email: mailbox.email) { [google] force in try await google.accessToken(mailbox.email, force: force) }
            if let loaded = try? await api.thread(thread), loaded.mailbox == mailbox.email,
               user?.id == originalUser, store.mailbox(mailbox.email) != nil { store.upsert(threads: [loaded]) }
        }
        if let thread = destination.thread, mailbox.provider == .outlook, store.thread(thread)?.mailbox.lowercased() != mailbox.email.lowercased() {
            await sync?.loadNotificationThread(thread, email: mailbox.email)
        }
    }

    func refreshNotificationConnections() async {
        guard let userId = user?.id, let result = try? await relay.notificationConnections(), user?.id == userId else { return }
        notificationConnections = Dictionary(uniqueKeysWithValues: result.connections.map { ($0.email.lowercased(), $0) })
        notificationProviders = Set(result.providers.filter { $0.value }.map(\.key))
        configurePush()
    }
    func connectNotifications(_ email: String) async throws {
        guard let mailbox = store.mailbox(email), !mailbox.signedOut, let userId = user?.id else { return }
        busy = "Connecting notifications…"
        defer { busy = nil }
        if let settings = mailbox.imap {
            guard let password = ImapProvider.password(email) else { throw ImapError.signedOut }
            try await relay.connectImapNotifications(email, settings: settings, password: password)
        } else {
            let url = try await relay.authorizeNotifications(email)
            try await notificationAuthorization.authorize(url)
        }
        guard user?.id == userId else { return }
        await refreshNotificationConnections()
        await requestNotifications()
        configurePush()
    }

    private func offerNotifications(_ email: String) async {
        await refreshNotificationConnections()
        guard preferences.notifications != .off, let mailbox = store.mailbox(email), mailbox.imap == nil,
              notificationProviders.contains(mailbox.provider.rawValue), notificationConnections[email.lowercased()]?.status != "ready" else { return }
        // Mail sign-in remains usable if the user cancels the separate limited permission.
        do { try await connectNotifications(email) } catch { await refreshNotificationConnections() }
    }
    func disconnectNotifications(_ email: String) async throws {
        try await relay.disconnectNotifications(email)
        await refreshNotificationConnections()
    }
}
