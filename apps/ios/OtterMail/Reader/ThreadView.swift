import SwiftUI

/**
 * A conversation: its subject as the headline, then each message, earlier
 * read ones folded to a line. Compact reply and archive buttons sit at the
 * bottom; archiving moves on as Settings › After archive says.
 */
struct ThreadView: View {
    @Environment(MailStore.self) private var store
    @Environment(Preferences.self) private var preferences
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let threadID: String
    let place: Place
    @Binding var path: [String]
    @Binding var draft: Draft?

    /** The list as it was when this opened, to know what's next once this one leaves it. */
    @State private var siblings: [String] = []
    @State private var expanded: Set<String> = []
    @State private var asking: [MailContext]?

    var body: some View {
        if let thread = store.thread(threadID), let mailbox = store.mailbox(thread.mailbox) {
            content(thread, mailbox)
        } else {
            ContentUnavailableView("Deleted", systemImage: "trash")
        }
    }

    private func content(_ thread: MailThread, _ mailbox: Mailbox) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Text(thread.subject)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(palette.text)
                    .textSelection(.enabled)
                    .padding(.bottom, 8)
                    .padding(.horizontal, MessageView.inset)

                labels(thread, mailbox)
                    .padding(.bottom, 20)
                    .padding(.horizontal, MessageView.inset)

                ForEach(thread.messages) { message in
                    let open = message.id == thread.messages.last?.id || message.unread || expanded.contains(message.id)
                    MessageView(message: message, mailbox: mailbox, open: open) {
                        if message.draft {
                            draft = .resume(message, in: thread)
                        } else if !open {
                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { _ = expanded.insert(message.id) }
                        }
                    }
                    if message.id != thread.messages.last?.id {
                        Spacer().frame(height: 20)
                    }
                }
            }
            .padding(.top, 8)
        }
        .minimizingNavigationBar()
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .contentMargins(.bottom, 24, for: .scrollContent)
        .toolbar {
            if session.agent.isOn {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { asking = [MailContext(thread)] } label: { Label("Ask the agent", image: "OtterAgent") }
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(thread.starred ? "Un\(mailbox.mark)" : mailbox.mark.capitalized, systemImage: thread.starred ? "\(mailbox.mark).fill" : mailbox.mark) {
                    store.toggleStar(thread.id)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu("More", systemImage: "ellipsis") {
                    Button("Reply all", systemImage: "arrowshape.turn.up.left.2") {
                        draft = .reply(to: thread, in: mailbox, all: true)
                    }
                    Button("Forward", systemImage: "arrowshape.turn.up.right") {
                        draft = .forward(thread, in: mailbox)
                    }
                    if let unsubscribe = Unsubscribe(thread.sent.last?.headers ?? [:]) {
                        Button("Unsubscribe", systemImage: "hand.raised") {
                            Task { await unsubscribe.run(from: mailbox, compose: { draft = $0 }) }
                        }
                    }
                    Divider()
                    ThreadActions(thread: thread, onGone: { leave(thread) })
                }
            }
        }
        .safeAreaBar(edge: .bottom) {
            replyBar(thread, mailbox)
        }
        // Its own bar (archive, trash, reply) stands in for the tabs.
        .toolbarVisibility(.hidden, for: .tabBar)
        .sheet(isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })) {
            NavigationStack {
                AgentView(context: asking ?? [], sheet: true)
            }
            .onAppear { session.agent.newChat() }
        }
        .toolbarTitleDisplayMode(.inline)
        .onAppear {
            if siblings.isEmpty { siblings = store.threads(in: place.folder, scope: place.scope).map(\.id) }
            if thread.unread { store.setRead(true, thread.id) }
        }
    }

    @ViewBuilder
    private func labels(_ thread: MailThread, _ mailbox: Mailbox) -> some View {
        let userLabels = mailbox.labels.filter { thread.labels.contains($0.id) }
        HStack(spacing: 6) {
            Circle().fill(Color(hex: mailbox.color)).frame(width: 7, height: 7)
            Text(mailbox.displayName)
                .font(.footnote)
                .foregroundStyle(palette.muted)
                .padding(.trailing, 2)
            ForEach(userLabels) { label in
                Text(label.leaf)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(palette.text)
                    .padding(.horizontal, 7)
                    .frame(height: 20)
                    .background((label.color.map(Color.init(hex:)) ?? palette.muted).opacity(0.18), in: .capsule)
            }
        }
    }

    /** Archive (in the Archive, Move to Inbox) and Trash stay together, with Reply on the other side of the message. */
    private func replyBar(_ thread: MailThread, _ mailbox: Mailbox) -> some View {
        let archives = store.canArchive(thread)
        let unarchives = !archives && thread.labels.contains("ARCHIVE")
        return HStack(spacing: 10) {
            Button(archives ? "Archive" : unarchives ? "Move to Inbox" : "Trash",
                   systemImage: archives ? "archivebox" : unarchives ? "tray.and.arrow.down" : "trash") {
                if archives { store.archive(thread.id) } else if unarchives { store.moveToInbox(thread.id) } else { store.trash(thread.id) }
                leave(thread)
            }
            .labelStyle(.iconOnly)
            .font(.system(size: 19))
            .foregroundStyle(palette.text)
            .frame(width: 44, height: 44)
            .glassEffect(.regular.interactive(), in: .circle)

            if archives || unarchives {
                Button("Trash", systemImage: "trash") {
                    store.trash(thread.id)
                    leave(thread)
                }
                .labelStyle(.iconOnly)
                .font(.system(size: 19))
                .foregroundStyle(palette.text)
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive(), in: .circle)
            }

            Spacer()

            Button("Reply to \(replyName(thread, mailbox))", systemImage: "arrowshape.turn.up.left") {
                draft = .reply(to: thread, in: mailbox, all: false)
            }
            .labelStyle(.iconOnly)
            .font(.system(size: 19))
            .foregroundStyle(palette.text)
            .frame(width: 44, height: 44)
            .glassEffect(.regular.interactive(), in: .circle)
            .contextMenu {
                Button("Reply", systemImage: "arrowshape.turn.up.left") {
                    draft = .reply(to: thread, in: mailbox, all: false)
                }
                Button("Reply all", systemImage: "arrowshape.turn.up.left.2") {
                    draft = .reply(to: thread, in: mailbox, all: true)
                }
                Button("Forward", systemImage: "arrowshape.turn.up.right") {
                    draft = .forward(thread, in: mailbox)
                }
            }
            .accessibilityHint("Touch and hold for Reply all or Forward")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }

    private func replyName(_ thread: MailThread, _ mailbox: Mailbox) -> String {
        let last = thread.sent.last ?? thread.latest
        let person = last.from.isAddress(mailbox.email) ? last.to.first ?? last.from : last.from
        return person.label.split(separator: " ").first.map(String.init) ?? person.label
    }

    /** After archive, trash or a move: the next or previous thread, or back to the list. */
    private func leave(_ thread: MailThread) {
        let remaining = Set(store.threads(in: place.folder, scope: place.scope).map(\.id))
        let index = siblings.firstIndex(of: thread.id) ?? 0
        let after = siblings[(index + 1)...].first(where: remaining.contains)
        let before = siblings[..<index].last(where: remaining.contains)
        let next: String? = switch preferences.advance {
        case .next: after ?? before
        case .previous: before ?? after
        case .none: nil
        }
        if let next {
            path = [next]
        } else {
            path = []
        }
    }
}
