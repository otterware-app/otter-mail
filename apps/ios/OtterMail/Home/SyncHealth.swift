import SwiftUI

/**
 * How each mailbox's sync is doing, as on the Mac and the web: a line at the
 * foot of the drawer, always, and the one failure only the user can fix, a
 * sign-in the provider ended, raised on the mail list with the button that
 * fixes it.
 */

/** "Contoso is signed out", "Contoso needs its password". */
func signedOutTitle(_ mailbox: Mailbox) -> String {
    mailbox.imap != nil ? "\(mailbox.displayName) needs its password" : "\(mailbox.displayName) is signed out"
}

/** Signs a mailbox back in: Google or Microsoft with the address filled in, or its password. */
struct SignInAgainButton: View {
    @Environment(Session.self) private var session
    let mailbox: Mailbox
    /** A settings row's own label; the banner and drawer have the short one. */
    var title: String?

    @State private var askPassword = false
    @State private var password = ""
    @State private var error: String?

    var body: some View {
        Button(title ?? (mailbox.imap != nil ? "Enter password" : "Sign in")) {
            if mailbox.imap != nil { askPassword = true } else { run { try await session.signIn(mailbox: mailbox.email) } }
        }
        .font(title == nil ? .subheadline.weight(.semibold) : nil)
        .disabled(session.busy != nil)
        .alert("Password for \(mailbox.email)", isPresented: $askPassword) {
            SecureField("Password", text: $password)
            Button("Cancel", role: .cancel) { password = "" }
            Button("Sign in") {
                let entered = password
                password = ""
                run { try await session.signIn(mailbox: mailbox.email, password: entered) }
            }
        } message: {
            if let host = mailbox.imap?.imap.host { Text("It stays on this iPhone; your mail goes straight to \(host).") }
        }
        .alert("Couldn't sign in", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
    }

    private func run(_ signIn: @escaping () async throws -> Void) {
        Task {
            do { try await signIn() }
            catch GoogleAuth.Failure.cancelled {} catch MicrosoftAuth.Failure.cancelled {} catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/** On the mail list: each mailbox whose sign-in was ended, until it's back or closed. */
struct SignedOutBanners: View {
    @Environment(MailStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var closed: Set<String> = []

    var body: some View {
        let lost = store.shownMailboxes.filter { $0.signedOut && store.lostSignIn.contains($0.email) && !closed.contains($0.email) }
        if !lost.isEmpty {
            VStack(spacing: 8) {
                ForEach(lost) { mailbox in
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(palette.warning)
                        Text(signedOutTitle(mailbox)).font(.subheadline).lineLimit(1)
                        Spacer(minLength: 8)
                        SignInAgainButton(mailbox: mailbox)
                        Button("Close", systemImage: "xmark") { closed.insert(mailbox.email) }
                            .labelStyle(.iconOnly)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.muted)
                    }
                    .foregroundStyle(palette.text)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 52)
                    .background(palette.raised, in: .rect(cornerRadius: 18))
                    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(palette.border))
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
    }
}

/** The drawer's foot: how the mailboxes on the page are syncing (All: the worst of them). Tap to sync now. */
struct SyncStatusLine: View {
    @Environment(MailStore.self) private var store
    @Environment(\.palette) private var palette
    let scope: String?

    var body: some View {
        let mailboxes = store.shownMailboxes.filter { scope == nil || $0.email == scope }
        // A signed-out mailbox's own page says so above its folders.
        if !store.isDemo, !mailboxes.isEmpty, scope == nil || !mailboxes.contains(where: \.signedOut) {
            let (text, warning) = status(mailboxes)
            Button {
                Task {
                    for mailbox in mailboxes where !mailbox.signedOut { await store.sync?.sync(mailbox.email) }
                }
            } label: {
                HStack(spacing: 6) {
                    if warning { Circle().fill(palette.warning).frame(width: 6, height: 6) }
                    Text(text).lineLimit(1)
                }
                .font(.footnote)
                .foregroundStyle(warning ? palette.sidebarText : palette.sidebarMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Syncs now")
        }
    }

    private func status(_ mailboxes: [Mailbox]) -> (String, Bool) {
        if let out = mailboxes.first(where: \.signedOut) { return (signedOutTitle(out), true) }
        let health = mailboxes.map { store.health[$0.email] ?? MailStore.SyncHealth() }
        if let failure = health.compactMap(\.failure).first { return ("\(failure) — will retry", true) }
        let synced = health.map(\.syncedAt)
        if synced.contains(nil) { return ("Syncing…", false) }
        let oldest = synced.compactMap { $0 }.min() ?? .now
        return (Date.now.timeIntervalSince(oldest) < 60 ? "Synced just now" : "Synced \(oldest.formatted(.relative(presentation: .named)))", false)
    }
}
