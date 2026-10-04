import SwiftUI

/**
 * Settings › Agents: the two server agents, their connections and models.
 */
struct AgentSettings: View {
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette

    @State private var url = ""
    @State private var key = ""
    @State private var connecting = false
    @State private var routerKey = ""
    @State private var error: String?

    var body: some View {
        @Bindable var agent = session.agent
        SettingsForm {
            Section {
                Picker("Agent", selection: $agent.selected) {
                    Text("OpenRouter").tag("openrouter")
                    Text("Hermes").tag("hermes")
                }
            }
            if agent.selected == "openrouter" {
                Section {
                    Toggle("OpenRouter", isOn: $agent.openrouter.enabled)
                    if agent.openrouter.enabled {
                        LabeledContent("Status", value: statusText)
                        SecureField("OpenRouter API key", text: $routerKey)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button(connecting ? "Connecting…" : agent.hasOpenRouterKey ? "Update key" : "Connect") {
                            connecting = true
                            error = nil
                            Task {
                                do { try await agent.connectOpenRouter(key: routerKey); routerKey = "" }
                                catch { self.error = error.localizedDescription }
                                connecting = false
                            }
                        }
                        .disabled(routerKey.isEmpty || connecting || !session.relay.isSignedIn)
                        if agent.hasOpenRouterKey {
                            Picker("Model", selection: $agent.openrouter.model) {
                                Text("Server default").tag("")
                                ForEach(agent.models) { Text($0.name).tag($0.slug) }
                            }
                            Picker("Tool approval", selection: $agent.openrouter.runtimeMode) {
                                Text("Supervised").tag("approval-required")
                                Text("Auto accept edits").tag("auto-accept-edits")
                                Text("Full access").tag("full-access")
                            }
                            Button("Disconnect", role: .destructive) {
                                Task { do { try await agent.disconnectOpenRouter() } catch { self.error = error.localizedDescription } }
                            }
                        }
                        if let error { Text(error).foregroundStyle(palette.error) }
                        if case .failed(let message) = agent.status { Text(message).foregroundStyle(palette.error) }
                        Link("Get an API key", destination: URL(string: "https://openrouter.ai/settings/keys")!)
                        Link("Usage and credits", destination: URL(string: "https://openrouter.ai/activity")!)
                    }
                } footer: {
                    Text(session.relay.isSignedIn ? "The API key stays on Otter Mail's server. When you use this agent, your prompts and mail returned by its tools are sent to Otter Mail's server, OpenRouter and the selected model provider. Chat history stays until you delete the chat or your Otter account. Usage is billed to your OpenRouter account." : "Sign in to your Otter account to connect OpenRouter.")
                }
            } else {
                Section {
                    Toggle(isOn: $agent.hermes.enabled) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Hermes")
                                Text(statusText).font(.subheadline).foregroundStyle(statusColor)
                            }
                        } icon: {
                            Image("AgentCursor")
                        }
                    }
                    if agent.isOn && agent.hasKey && !agent.hermes.baseUrl.isEmpty {
                        LabeledContent("Server") {
                            Text(URL(string: agent.hermes.baseUrl)?.host() ?? agent.hermes.baseUrl)
                                .foregroundStyle(palette.muted)
                        }
                        if !agent.models.isEmpty {
                            Picker("Model", selection: $agent.hermes.model) {
                                Text("Hermes' default").tag("")
                                ForEach(agent.models.filter { !$0.slug.isEmpty }) { model in
                                    Text(model.subProvider.map { "\(model.name) · \($0)" } ?? model.name).tag(model.slug)
                                }
                            }
                        }
                        if let model = agent.model, model.reasoning {
                            Picker("Reasoning", selection: $agent.hermes.reasoningEffort) {
                                ForEach(AgentView.efforts(model), id: \.0) { Text($0.1).tag($0.0) }
                            }
                        }
                        if let model = agent.model, model.fast {
                            Toggle("Fast", isOn: Binding(
                                get: { agent.hermes.serviceTier == "priority" },
                                set: { agent.hermes.serviceTier = $0 ? "priority" : "default" }
                            ))
                        }
                        Button("Disconnect", role: .destructive) { agent.disconnect() }
                    } else if agent.isOn {
                        TextField("https://hermes.example:8642", text: $url)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        SecureField("API key", text: $key)
                        Button(connecting ? "Connecting…" : "Connect") {
                            connecting = true
                            Task {
                                await agent.connect(url: url, key: key)
                                connecting = false
                            }
                        }
                        .disabled(url.isEmpty || key.isEmpty || connecting)
                    }
                } footer: {
                    Text("Your agent server, reached from every device. Chats live on it, so they're the same here, on the Mac and on the web. The key follows your Otter account, sealed.")
                }
            }
        }
        .navigationTitle("Agents")
        .toolbarTitleDisplayMode(.inline)
        .onAppear { url = session.agent.hermes.baseUrl }
        .task(id: "\(session.agent.selected):\(session.agent.isOn)") { await session.agent.check() }
    }

    private var statusText: String {
        guard session.agent.isOn else { return "Off" }
        return switch session.agent.status {
        case .notConfigured: "Not connected"
        case .checking: "Checking…"
        case .ready: "Connected"
        case .failed: "Not answering"
        }
    }

    private var statusColor: Color {
        switch session.agent.status {
        case .ready: palette.focus
        case .failed: palette.error
        default: palette.muted
        }
    }
}
