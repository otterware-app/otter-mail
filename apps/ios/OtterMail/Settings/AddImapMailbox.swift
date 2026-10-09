import SwiftUI

/**
 * Settings › Mailboxes › Add IMAP mailbox: the address and password, the
 * servers found for the address (or set by hand under Server settings),
 * checked by logging in before the mailbox is added to the Otter account.
 */
struct AddImapMailbox: View {
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    @State private var email = ""
    @State private var password = ""
    @State private var username = ""
    @State private var imap = MailServer(host: "", port: 993, security: .tls)
    @State private var smtp = MailServer(host: "", port: 465, security: .tls)
    @State private var showsServers = false
    @State private var note: String?
    @State private var finding = false
    @State private var error: String?
    @State private var backgroundNotifications = false

    private var domain: String {
        let parts = email.trimmingCharacters(in: .whitespaces).split(separator: "@")
        return parts.count == 2 && parts[1].contains(".") ? parts[1].lowercased() : ""
    }

    private var canAdd: Bool {
        !domain.isEmpty && !password.isEmpty && !imap.host.isEmpty && !smtp.host.isEmpty && session.busy == nil
    }

    var body: some View {
        SettingsForm {
            Section {
                Toggle("Background notifications", isOn: $backgroundNotifications)
            } footer: {
                Text("When enabled, Otter securely stores the IMAP password to watch for new mail while the app is closed. The watcher reads message IDs and flags; previews load directly on your iPhone.")
            }
            Section {
                TextField("Email", text: $email)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textContentType(.password)
            } footer: {
                if finding {
                    Text("Looking for the servers…")
                } else if let note {
                    Text(note)
                }
            }

            Section {
                DisclosureGroup("Server settings", isExpanded: $showsServers) {
                    LabeledContent("Username") {
                        TextField(email.isEmpty ? "Usually the address" : email, text: $username)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    ServerFields(title: "IMAP", server: $imap, ports: (993, 143))
                    ServerFields(title: "SMTP", server: $smtp, ports: (465, 587))
                }
                .tint(palette.text)
            } footer: {
                Text("The password stays on this iPhone. The servers follow your Otter account; your other devices ask for the password once.")
            }

            Section {
                Button {
                    Task { await add() }
                } label: {
                    Label(session.busy ?? "Add mailbox", systemImage: "plus")
                }
                .disabled(!canAdd)
            }
        }
        .foregroundStyle(palette.text)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("IMAP mailbox")
        .toolbarTitleDisplayMode(.inline)
        .task(id: domain) { await discover() }
        .alert("Couldn't add the mailbox", isPresented: .constant(error != nil)) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "")
        }
    }

    /** Fills in the servers for the address's domain (once the typing stops). */
    private func discover() async {
        guard !domain.isEmpty else { return }
        try? await Task.sleep(for: .milliseconds(600))
        guard !Task.isCancelled else { return }
        finding = true
        defer { finding = false }
        do {
            let found = try await MailDiscovery.find(email.trimmingCharacters(in: .whitespaces))
            guard !Task.isCancelled else { return }
            imap = found.settings.imap
            smtp = found.settings.smtp
            username = found.settings.username
            note = found.note
        } catch {
            // Gmail or Outlook: nothing to add here.
            imap.host = ""
            smtp.host = ""
            note = error.localizedDescription
        }
    }

    private func add() async {
        let email = email.trimmingCharacters(in: .whitespaces)
        let settings = ImapSettings(
            username: username.isEmpty ? email : username,
            imap: MailServer(host: imap.host.trimmingCharacters(in: .whitespaces), port: imap.port, security: imap.security),
            smtp: MailServer(host: smtp.host.trimmingCharacters(in: .whitespaces), port: smtp.port, security: smtp.security)
        )
        do {
            try await session.addImapMailbox(email, settings: settings, password: password)
            if backgroundNotifications { try await session.connectNotifications(email) }
            dismiss()
        } catch {
            let hint = await MailDiscovery.certificateHint(error, email: email, tried: [settings.imap.host, settings.smtp.host])
            self.error = hint ?? error.localizedDescription
            showsServers = true
        }
    }
}

/** A server's host, port and security; switching security switches between its usual ports. */
private struct ServerFields: View {
    let title: String
    @Binding var server: MailServer
    /** The usual ports: with TLS from the start, and with STARTTLS. */
    let ports: (tls: Int, starttls: Int)

    var body: some View {
        LabeledContent("\(title) server") {
            TextField("\(title.lowercased()).example.com", text: $server.host)
                .multilineTextAlignment(.trailing)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        LabeledContent("Port") {
            TextField("Port", value: $server.port, format: .number.grouping(.never))
                .multilineTextAlignment(.trailing)
                .keyboardType(.numberPad)
        }
        Picker("Security", selection: Binding(
            get: { server.security },
            set: { security in
                if server.port == (server.security == .tls ? ports.tls : ports.starttls) {
                    server.port = security == .tls ? ports.tls : ports.starttls
                }
                server.security = security
            }
        )) {
            Text("TLS").tag(MailServer.Security.tls)
            Text("STARTTLS").tag(MailServer.Security.starttls)
        }
    }
}
