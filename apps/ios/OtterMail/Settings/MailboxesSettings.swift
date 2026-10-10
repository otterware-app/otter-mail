import SwiftUI

/**
 * Settings › Mailboxes, as on the desktop: "All mailboxes", each mailbox on
 * or off, their order (Edit, then drag), and adding one. The arrangement
 * and the mailboxes follow the Otter account to every device.
 */
struct MailboxesSettings: View {
    @Environment(Session.self) private var session
    @Environment(MailStore.self) private var store
    @Environment(Preferences.self) private var preferences
    @Environment(\.palette) private var palette
    @State private var error: String?

    var body: some View {
        SettingsForm {
            Section {
                Toggle(isOn: Binding(
                    get: { preferences.arrangement.combined },
                    set: { preferences.arrangement.combined = $0 }
                )) {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("All mailboxes")
                            Text("One inbox for every mailbox").font(.subheadline).foregroundStyle(palette.muted)
                        }
                    } icon: {
                        Image(systemName: "square.stack")
                    }
                }
            }

            Section {
                let shown = store.shownMailboxes
                ForEach(store.arrangedMailboxes) { mailbox in
                    let on = shown.contains(mailbox)
                    NavigationLink {
                        MailboxSettings(email: mailbox.email)
                    } label: {
                        HStack(spacing: 12) {
                            MailboxMark(mailbox: mailbox, size: 30)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(mailbox.displayName).foregroundStyle(palette.text)
                                Text(mailbox.signedOut ? "Sign in on this iPhone" : mailbox.email)
                                    .font(.subheadline)
                                    .foregroundStyle(mailbox.signedOut ? palette.warning : palette.muted)
                            }
                            Spacer()
                            Toggle("Show \(mailbox.displayName)", isOn: Binding(
                                get: { on },
                                set: { store.setOn($0, mailbox) }
                            ))
                            .labelsHidden()
                            // The last mailbox on stays on.
                            .disabled(on && shown.count == 1)
                        }
                    }
                }
                .onMove { store.move(from: $0, to: $1) }

                if !store.isDemo {
                    Button {
                        Task {
                            do { try await session.addMailbox() } catch GoogleAuth.Failure.cancelled {} catch {
                                self.error = error.localizedDescription
                            }
                        }
                    } label: {
                        Label(session.busy ?? "Add Gmail mailbox", systemImage: "plus")
                    }
                    .disabled(session.busy != nil)
                    Button {
                        Task {
                            do { try await session.addOutlookMailbox() } catch MicrosoftAuth.Failure.cancelled {} catch {
                                self.error = error.localizedDescription
                            }
                        }
                    } label: {
                        Label { Text("Add Outlook mailbox") } icon: { MicrosoftMark() }
                    }
                    .disabled(session.busy != nil)
                    NavigationLink {
                        AddImapMailbox()
                    } label: {
                        Label("Add IMAP mailbox", systemImage: "envelope.badge")
                    }
                    .disabled(session.busy != nil)
                }
            } footer: {
                Text("Turned-off mailboxes stay signed in but aren't shown or synced, on every device.")
            }
        }
        .navigationTitle("Mailboxes")
        .toolbarTitleDisplayMode(.inline)
        .toolbar { EditButton() }
        .alert("Couldn't add the mailbox", isPresented: .constant(error != nil)) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "")
        }
    }
}

/** One mailbox: signing in here, its name and color, its signature, and removing it. */
struct MailboxSettings: View {
    @Environment(Session.self) private var session
    @Environment(MailStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    let email: String
    @State private var name = ""
    @State private var confirmRemove = false
    @State private var confirmNotifications = false
    @State private var password = ""
    @State private var error: String?

    var body: some View {
        if let mailbox = store.mailbox(email) {
            form(mailbox)
        }
    }

    private func form(_ mailbox: Mailbox) -> some View {
        SettingsForm {
            if !mailbox.signedOut, session.notificationProviders.contains(mailbox.provider.rawValue) {
                Section {
                    let connection = session.notificationConnections[email.lowercased()]
                    LabeledContent("Background notifications", value: notificationStatus(connection?.status))
                    if connection != nil {
                        Button("Disconnect background notifications") {
                            Task { do { try await session.disconnectNotifications(email) } catch { self.error = error.localizedDescription } }
                        }
                    }
                    if connection?.status != "ready" {
                        Button(session.busy ?? "Connect notifications") {
                            if mailbox.imap != nil { confirmNotifications = true } else { connectNotifications() }
                        }.disabled(session.busy != nil)
                    }
                } footer: {
                    Text(mailbox.imap != nil
                        ? "Otter securely stores the IMAP password to watch for new mail. The watcher reads new-mail metadata; sender and preview load directly on this iPhone."
                        : "Otter needs limited provider permission to confirm new mail before sending an alert. Sender and preview load directly on this iPhone.")
                }
                .confirmationDialog("Enable IMAP background notifications?", isPresented: $confirmNotifications, titleVisibility: .visible) {
                    Button("Enable notifications") { connectNotifications() }
                } message: {
                    Text("Otter will securely store this mailbox’s password and connect to its IMAP server. The password permits mailbox access; the watcher requests only metadata needed to identify new mail.")
                }
            }
            if mailbox.signedOut, let imap = mailbox.imap {
                Section {
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit(signInImap)
                    Button(action: signInImap) {
                        Label(session.busy ?? "Sign in to \(email)", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .disabled(password.isEmpty || session.busy != nil)
                } header: {
                    // Whose password, and where it goes: the servers can change on another device.
                    Text("\(imap.username) on \(imap.imap.host)")
                        .textCase(nil)
                } footer: {
                    Text("This iPhone needs the password: the mailbox is new here, the server refused it, or its servers changed. It stays on this iPhone; your mail goes straight between it and \(imap.imap.host).")
                }
            } else if mailbox.signedOut {
                let outlook = mailbox.provider == .outlook
                Section {
                    Button {
                        Task {
                            do { try await session.signIn(mailbox: email) }
                            catch GoogleAuth.Failure.cancelled {} catch MicrosoftAuth.Failure.cancelled {} catch {
                                self.error = error.localizedDescription
                            }
                        }
                    } label: {
                        if outlook {
                            Label { Text(session.busy ?? "Sign in with Microsoft") } icon: { MicrosoftMark() }
                        } else {
                            Label(session.busy ?? "Sign in to \(email)", systemImage: "person.crop.circle.badge.checkmark")
                        }
                    }
                    .disabled(session.busy != nil)
                } footer: {
                    Text("Linked to your Otter account, but this iPhone isn't signed in to it yet. Your mail goes straight between the iPhone and \(outlook ? "Outlook" : "Gmail").")
                }
            }

            Section {
                LabeledContent("Display name") {
                    TextField("Name", text: $name)
                        .multilineTextAlignment(.trailing)
                        .onSubmit { rename(mailbox) }
                }
                ColorPicker("Color", selection: Binding(
                    get: { Color(hex: mailbox.color) },
                    set: { var m = mailbox; m.color = $0.hex; session.update(m) }
                ), supportsOpacity: false)
            } footer: {
                Text("Shown in the sidebar and on its mail, on every device. Only used in Otter Mail.")
            }

            if !mailbox.signedOut {
                Section {
                    SignatureEditor(
                        html: mailbox.signature,
                        savedIn: mailbox.capabilities.serverSignatures ? "Gmail" : "your Otter account",
                        signIn: mailbox.provider == .gmail ? { try await session.signIn(mailbox: email) } : nil
                    ) { html in
                        try await session.setSignature(html, for: email)
                    }
                } header: {
                    Text("Signature")
                } footer: {
                    Text(mailbox.capabilities.serverSignatures
                        ? "Added to new messages, replies and forwards from this mailbox. Saved in Gmail, so it's the same there and on every device."
                        : "Added to new messages, replies and forwards from this mailbox. Saved with your Otter account, so it's the same on every device.")
                }
            }

            Section {
                Button("Remove mailbox", role: .destructive) { confirmRemove = true }
                    .confirmationDialog("Remove \(mailbox.displayName)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                        Button("Remove", role: .destructive) {
                            dismiss()
                            Task { await session.remove(mailbox) }
                        }
                    } message: {
                        Text("Removes it from your Otter account on every device and signs this iPhone out of it. Nothing is deleted from \(Self.server(mailbox)).")
                    }
            }
        }
        .navigationTitle(mailbox.displayName)
        .toolbarTitleDisplayMode(.inline)
        .onAppear { name = mailbox.displayName }
        .task {
            while !Task.isCancelled {
                await session.refreshNotificationConnections()
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .onDisappear { rename(mailbox) }
        .alert("Couldn't sign in", isPresented: .constant(error != nil)) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "")
        }
    }

    private func connectNotifications() {
        Task { do { try await session.connectNotifications(email) } catch { self.error = error.localizedDescription } }
    }
    private func notificationStatus(_ status: String?) -> String {
        switch status {
        case "ready": "Connected"
        case "connecting": "Checking…"
        case "retry": "Retrying connection"
        case "reauthorize": "Reconnect required"
        default: "Not connected"
        }
    }

    /** Where the mailbox's mail stays. */
    private static func server(_ mailbox: Mailbox) -> String {
        switch mailbox.provider {
        case .gmail: "Gmail"
        case .outlook: "Outlook"
        case .imap: "the server"
        }
    }

    private func signInImap() {
        guard !password.isEmpty else { return }
        Task {
            do {
                try await session.signIn(mailbox: email, password: password)
                password = ""
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func rename(_ mailbox: Mailbox) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != mailbox.displayName else { return }
        var m = mailbox
        m.displayName = trimmed
        session.update(m)
    }
}

/** Settings › Languages I read: the first is where translations go. */
struct LanguagesSettings: View {
    @Environment(Preferences.self) private var preferences
    @Environment(\.palette) private var palette

    private static let choices = ["en", "fr", "de", "es", "it", "pt", "nl", "sv", "pl", "tr", "ru", "uk", "ar", "hi", "vi", "ja", "ko", "zh"]

    var body: some View {
        let read = preferences.effectiveReadLanguages
        SettingsForm {
            Section {
                ForEach(read, id: \.self) { code in
                    Text(name(code))
                }
                .onMove { preferences.readLanguages = moved(read, $0, $1) }
                .onDelete { offsets in
                    var next = read
                    next.remove(atOffsets: offsets)
                    if !next.isEmpty { preferences.readLanguages = next }
                }
            } footer: {
                Text("Mail in these isn't translated. The first is the language translations go into.")
            }

            Section("Add") {
                ForEach(Self.choices.filter { !read.contains($0) }, id: \.self) { code in
                    Button(name(code)) { preferences.readLanguages = read + [code] }
                        .foregroundStyle(palette.text)
                }
            }
        }
        .navigationTitle("Languages I read")
        .toolbarTitleDisplayMode(.inline)
        .toolbar { EditButton() }
    }

    private func name(_ code: String) -> String {
        Locale.current.localizedString(forLanguageCode: code) ?? code
    }

    private func moved(_ list: [String], _ from: IndexSet, _ to: Int) -> [String] {
        var list = list
        list.move(fromOffsets: from, toOffset: to)
        return list
    }
}

/** Microsoft's four squares, beside what signs in with Microsoft. */
struct MicrosoftMark: View {
    var size: CGFloat = 18

    var body: some View {
        let square = size * 0.46
        Grid(horizontalSpacing: size * 0.08, verticalSpacing: size * 0.08) {
            GridRow {
                Rectangle().fill(Color(hex: "#f25022")).frame(width: square, height: square)
                Rectangle().fill(Color(hex: "#7fba00")).frame(width: square, height: square)
            }
            GridRow {
                Rectangle().fill(Color(hex: "#00a4ef")).frame(width: square, height: square)
                Rectangle().fill(Color(hex: "#ffb900")).frame(width: square, height: square)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

extension Color {
    /** "#rrggbb", as the other apps store colors. */
    var hex: String {
        let c = UIColor(self).resolvedColor(with: .current)
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        let byte = { (v: CGFloat) in Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(r), byte(g), byte(b))
    }
}
