import SwiftUI

/**
 * The agent, ChatGPT's way: the model as the title (tap to switch), the
 * conversation, and a glass composer at the bottom. Conversations it's asked
 * about ride along as a chip, and go to the agent as pointers.
 */
struct AgentView: View {
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    /** Conversations to ask about (from the reader); removable before sending. */
    @State var context: [MailContext] = []
    /** Shown as a sheet (from a conversation) rather than in the frame. */
    var sheet = false
    var onSettings: () -> Void = {}

    @State private var draft = ""
    @State private var showHistory = false
    @FocusState private var focused: Bool

    private var agent: Agent { session.agent }

    var body: some View {
        content
            .background(palette.canvas)
            .toolbar {
                if sheet {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", systemImage: "xmark") { dismiss() }
                    }
                }
                ToolbarItem(placement: .principal) { modelMenu }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Chats", systemImage: "clock.arrow.circlepath") { showHistory = true }
                        .disabled(agent.status != .ready)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New chat", systemImage: "square.and.pencil") { agent.newChat() }
                        .disabled(agent.turns.isEmpty)
                }
            }
            .toolbarTitleDisplayMode(.inline)
            .sheet(isPresented: $showHistory) { ChatHistory() }
            .task { if agent.status == .notConfigured || agent.models.isEmpty { await agent.check() } }
    }

    @ViewBuilder
    private var content: some View {
        switch agent.status {
        case .notConfigured:
            unavailable(
                "Connect \(agent.providerName)",
                "Connect your agent in Settings. Its chats live on the server and follow you to every device."
            )
        case .failed(let message):
            unavailable("\(agent.providerName) isn't answering", message)
        case .checking, .ready:
            conversation
        }
    }

    private func unavailable(_ title: String, _ message: String) -> some View {
        ContentUnavailableView {
            Label {
                Text(title)
            } icon: {
                Image("AgentCursor").resizable().scaledToFit().frame(width: 44, height: 44)
            }
        } description: {
            Text(message)
        } actions: {
            Button("Open Settings") { onSettings() }
                .buttonStyle(.glass)
            if case .failed = agent.status {
                Button("Try again") { Task { await agent.check() } }
            }
        }
        .foregroundStyle(palette.text)
    }

    // ── The conversation ─────────────────────────────────────────────────────

    private var conversation: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(agent.turns) { turn in
                        TurnView(turn: turn).id(turn.id)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 12)
            }
            .overlay {
                if agent.turns.isEmpty { welcome }
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: agent.turns.last?.text) {
                if let last = agent.turns.last { reader.scrollTo(last.id, anchor: .bottom) }
            }
            .safeAreaBar(edge: .bottom) {
                if let approval = agent.pendingApproval {
                    ApprovalCard(approval: approval)
                } else {
                    composer
                }
            }
        }
    }

    /** ChatGPT's empty chat: a question, and a few starts when there's mail to ask about. */
    private var welcome: some View {
        VStack(spacing: 18) {
            Text("What can I help with?")
                .font(.title2.weight(.semibold))
                .foregroundStyle(palette.text)
            if !context.isEmpty {
                VStack(spacing: 8) {
                    ForEach(["Summarize this conversation", "Draft a reply", "What do I need to do?"], id: \.self) { suggestion in
                        Button(suggestion) { send(suggestion) }
                            .font(.subheadline)
                            .foregroundStyle(palette.text)
                            .padding(.horizontal, 16)
                            .frame(height: 38)
                            .background(palette.card, in: .capsule)
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, 28)
    }

    // ── The composer ─────────────────────────────────────────────────────────

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !context.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(context, id: \.self) { item in
                            HStack(spacing: 6) {
                                Image(systemName: "envelope")
                                Text(item.subject).lineLimit(1)
                                Button("Remove", systemImage: "xmark") { context.removeAll { $0 == item } }
                                    .labelStyle(.iconOnly)
                                    .font(.caption.weight(.bold))
                            }
                            .font(.subheadline)
                            .foregroundStyle(palette.text)
                            .padding(.horizontal, 12)
                            .frame(height: 32, alignment: .leading)
                            .frame(maxWidth: 260, alignment: .leading)
                            .glassEffect(.regular, in: .capsule)
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField(agent.running ? (agent.selected == "hermes" ? "Steer Hermes…" : "Agent is working…") : "Ask \(agent.providerName)", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .disabled(agent.running && agent.selected == "openrouter")
                    .foregroundStyle(palette.text)
                    .padding(.vertical, 8)
                    .onSubmit { send(draft) }
                if agent.running && (draft.isEmpty || agent.selected == "openrouter") {
                    Button("Stop", systemImage: "stop.fill") { agent.stop() }
                        .labelStyle(.iconOnly)
                        .font(.system(size: 13))
                        .foregroundStyle(palette.actionText)
                        .frame(width: 34, height: 34)
                        .background(palette.action, in: .circle)
                } else {
                    Button("Send", systemImage: "arrow.up") { send(draft) }
                        .labelStyle(.iconOnly)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(palette.actionText)
                        .frame(width: 34, height: 34)
                        .background(palette.action, in: .circle)
                        .opacity(draft.trimmingCharacters(in: .whitespaces).isEmpty ? 0.35 : 1)
                        .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(.leading, 18)
            .padding(.trailing, 8)
            .padding(.vertical, 6)
            .glassEffect(.regular, in: .rect(cornerRadius: 26))
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    private func send(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !(agent.running && agent.selected == "openrouter") else { return }
        // The context goes with the first question of a chat.
        agent.send(text, context: agent.turns.isEmpty ? context : [])
        if agent.turns.count <= 2 { context = [] }
        draft = ""
    }

    // ── The model ────────────────────────────────────────────────────────────

    /** "Hermes · GPT-5 ⌄", ChatGPT's title menu: the model, its reasoning and speed. */
    private var modelMenu: some View {
        @Bindable var agent = session.agent
        let model = agent.model
        return Menu {
            let groups = Dictionary(grouping: agent.models) { $0.subProvider ?? agent.providerName }
            ForEach(groups.keys.sorted(), id: \.self) { group in
                Section(group) {
                    ForEach(groups[group] ?? []) { m in
                        Button {
                            agent.chosenModel = m.slug
                        } label: {
                            if m.id == model?.id { Label(m.name, systemImage: "checkmark") } else { Text(m.name) }
                        }
                    }
                }
            }
            if let model, model.reasoning {
                Picker("Reasoning", systemImage: "brain", selection: $agent.hermes.reasoningEffort) {
                    ForEach(Self.efforts(model), id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.menu)
            }
            if let model, model.fast {
                Toggle("Fast", systemImage: "hare", isOn: Binding(
                    get: { agent.hermes.serviceTier == "priority" },
                    set: { agent.hermes.serviceTier = $0 ? "priority" : "default" }
                ))
            }
        } label: {
            HStack(spacing: 4) {
                Text(agent.providerName).foregroundStyle(palette.text)
                if let model { Text(model.shortName).foregroundStyle(palette.muted).lineLimit(1) }
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.muted)
            }
            .font(.headline)
            .frame(maxWidth: 230)
        }
        .disabled(agent.models.isEmpty)
    }

    static func efforts(_ model: Hermes.Model) -> [(String, String)] {
        [("", "Default")] + (model.canDisableReasoning ? [("none", "Off")] : [])
            + [("minimal", "Minimal"), ("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "Extra High")]
    }
}

/** One turn: the question as a bubble, the answer as text with what the agent did. */
private struct TurnView: View {
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    let turn: Agent.Turn

    var body: some View {
        switch turn.role {
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                if !turn.context.isEmpty {
                    Label(turn.context.count > 1 ? "\(turn.context.count) conversations" : turn.context[0], systemImage: "envelope")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                        .lineLimit(1)
                }
                Text(turn.text)
                    .foregroundStyle(palette.text)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(palette.card, in: .rect(cornerRadius: 22))
                    .textSelection(.enabled)
                if let error = turn.error {
                    Text(error).font(.caption).foregroundStyle(palette.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 48)
        case .agent:
            VStack(alignment: .leading, spacing: 10) {
                if !turn.tools.isEmpty {
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(turn.tools) { tool in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tool.name).font(.caption.monospaced()).foregroundStyle(palette.text)
                                    if let output = tool.output {
                                        Text(output).font(.caption2.monospaced()).foregroundStyle(palette.muted).lineLimit(4)
                                    }
                                }
                            }
                        }
                        .padding(.top, 4)
                    } label: {
                        Label("Used \(turn.tools.count) tool\(turn.tools.count == 1 ? "" : "s")", systemImage: "wrench.and.screwdriver")
                            .font(.footnote)
                            .foregroundStyle(palette.muted)
                    }
                    .tint(palette.muted)
                }
                if turn.text.isEmpty && turn.error == nil && turn.approval == nil && session.agent.running {
                    ProgressView().controlSize(.small)
                }
                if !turn.text.isEmpty {
                    Text(Self.markdown(turn.text))
                        .foregroundStyle(palette.text)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .tint(palette.focus)
                }
                if let error = turn.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(palette.error)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

/**
 * An agent asking before it acts, ChatGPT's way (the desktop's approval-card):
 * in the composer's place, "Allow Hermes to …?", exactly what will happen, and
 * Deny or Allow once; allowing it for the rest of the chat is behind "…".
 */
private struct ApprovalCard: View {
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    let approval: Agent.Approval

    private static let more = ["session": "Allow for this chat", "always": "Always allow"]

    var body: some View {
        let agent = session.agent
        VStack(alignment: .leading, spacing: 12) {
            Label("Permissions", systemImage: "hand.raised")
                .font(.caption)
                .foregroundStyle(palette.muted)
            VStack(alignment: .leading, spacing: 6) {
                Text(approval.question)
                    .foregroundStyle(palette.text)
                if let detail = approval.detail, approval.isCommand {
                    Text(detail)
                        .font(.footnote.monospaced())
                        .foregroundStyle(palette.text)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(palette.canvas, in: .rect(cornerRadius: 10))
                }
                if let note = [approval.reason, approval.isCommand ? nil : approval.detail].compactMap(\.self).first {
                    Text(note).font(.footnote).foregroundStyle(palette.muted)
                }
            }
            HStack(spacing: 8) {
                Spacer()
                let extra = approval.choices.filter { Self.more[$0] != nil }
                if !extra.isEmpty {
                    Menu {
                        ForEach(extra, id: \.self) { choice in
                            Button(Self.more[choice]!) { agent.answer(approval, choice) }
                        }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 34, height: 34)
                    }
                    .foregroundStyle(palette.muted)
                }
                Button("Deny") { agent.answer(approval, "deny") }
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.cancelAction)
                Button("Allow once") { agent.answer(approval, "once") }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.action)
                    .foregroundStyle(palette.actionText)
                    .keyboardShortcut(.defaultAction)
            }
            .buttonBorderShape(.capsule)
            .tint(palette.text)
            .font(.subheadline.weight(.medium))
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }
}

/** The chats kept on Hermes (from every device and Hermes' own web UI), newest first. */
private struct ChatHistory: View {
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        let agent = session.agent
        let chats = agent.history.filter {
            query.isEmpty || ($0.title ?? "").localizedCaseInsensitiveContains(query) || ($0.preview ?? "").localizedCaseInsensitiveContains(query)
        }
        NavigationStack {
            List {
                ForEach(chats) { chat in
                    Button {
                        Task { await agent.open(chat) }
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(chat.title ?? chat.preview ?? "Untitled chat")
                                    .foregroundStyle(palette.text)
                                    .lineLimit(1)
                                Spacer()
                                Text(RelativeTime.short(chat.lastActive))
                                    .font(.subheadline)
                                    .foregroundStyle(palette.muted)
                            }
                            if let preview = chat.preview, chat.title != nil {
                                Text(preview).font(.subheadline).foregroundStyle(palette.muted).lineLimit(1)
                            }
                        }
                    }
                    .listRowBackground(palette.canvas)
                    .swipeActions {
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            Task { await agent.delete(chat) }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .overlay {
                if chats.isEmpty { ContentUnavailableView("No chats", systemImage: "bubble.left.and.bubble.right") }
            }
            .searchable(text: $query, prompt: "Search chats")
            .navigationTitle("Chats")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
            .task { await agent.loadHistory() }
        }
    }
}
