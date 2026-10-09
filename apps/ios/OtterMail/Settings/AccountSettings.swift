import SwiftUI

/**
 * Settings › Account, as on the desktop: the devices signed in to the Otter
 * account, signing out, and deleting the account.
 */
struct AccountSettings: View {
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    @State private var devices: [Relay.Device]?
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var error: String?

    var body: some View {
        SettingsForm {
            Section("Devices") {
                if let devices {
                    ForEach(devices) { device in
                        let here = device.token == session.relay.token?.split(separator: ".").first.map(String.init)
                        LabeledContent {
                            if here {
                                Text("This iPhone")
                            } else {
                                Button("Sign out", role: .destructive) {
                                    Task {
                                        try? await session.relay.revoke(device)
                                        await load()
                                    }
                                }
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(Self.name(device.userAgent))
                                Text("Active \(device.updatedAt.formatted(.relative(presentation: .named)))")
                                    .font(.subheadline)
                                    .foregroundStyle(palette.muted)
                            }
                        }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }

            Section {
                Button("Sign out of Otter Mail") { confirmSignOut = true }
                    .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                        Button("Sign out", role: .destructive) { Task { await session.signOut() } }
                    } message: {
                        Text("Your mail leaves this iPhone. It stays on its servers, and your mailboxes stay on your other devices.")
                    }
            }

            Section {
                Button("Delete Otter account", role: .destructive) { confirmDelete = true }
                    .confirmationDialog("Delete your Otter account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Delete account", role: .destructive) {
                            Task {
                                do { try await session.deleteAccount() } catch { self.error = error.localizedDescription }
                            }
                        }
                    } message: {
                        Text("Signs out every device and forgets your mailboxes and preferences. Your mail stays on its servers.")
                    }
            } footer: {
                Text("Your Otter account carries your mailboxes, themes and settings to the Mac and the web.")
            }
        }
        .navigationTitle("Otter account")
        .toolbarTitleDisplayMode(.inline)
        .task { await load() }
        .alert("Couldn't delete the account", isPresented: .constant(error != nil)) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "")
        }
    }

    private func load() async {
        devices = (try? await session.relay.devices())?.sorted { $0.updatedAt > $1.updatedAt } ?? []
    }

    /** A device's name from its session's user agent, as core's otter-account.ts reads it. */
    static func name(_ userAgent: String?) -> String {
        let ua = userAgent ?? ""
        if let match = ua.firstMatch(of: /^Otter Mail\/\S+ \((.+)\)$/) {
            return String(match.1).removingPercentEncoding ?? String(match.1)
        }
        if ua.contains("Edg/") { return "Edge" }
        if ua.contains("Firefox/") { return "Firefox" }
        if ua.contains("Chrome/") { return "Chrome" }
        if ua.contains("iPhone") { return "iPhone" }
        if ua.contains("Safari/") { return "Safari" }
        return "Unknown device"
    }
}

/** A profile picture from Google, or the otter while there's none. */
struct ProfilePicture: View {
    let url: String?
    var size: CGFloat = 36

    var body: some View {
        AsyncImage(url: url.flatMap(URL.init(string:))) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Image("OtterMark").resizable().scaledToFill()
        }
        .frame(width: size, height: size)
        .clipShape(.circle)
    }
}
