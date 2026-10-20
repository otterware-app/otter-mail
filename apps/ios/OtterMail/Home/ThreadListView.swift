import SwiftUI

/**
 * A folder's threads, laid out like Otter Code's task list: who, what, and a
 * line of it. The bottom bar is iOS's own: search and the agent (when it's on).
 * Compose lives in the sidebar, a swipe from the left or a tap on the title.
 */
struct ThreadListView: View {
    @Environment(MailStore.self) private var store
    @Environment(Preferences.self) private var preferences
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let place: Place
    let messageTransition: Namespace.ID
    let onDrawer: () -> Void
    let onAgent: () -> Void
    let onSettings: () -> Void
    let onResume: (Draft) -> Void

    @State private var collapsedDays: Set<Date> = []
    @State private var query = ""
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var swipedThread: String?
    /** What Gmail's search found for `query` (it knows mail that isn't loaded here). */
    @State private var found: (query: String, ids: [String]) = ("", [])

    var body: some View {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let threads = searching ? results : listed

        List {
            if !searching && !selecting && !recoveries.isEmpty {
                Section("On this iPhone") {
                    ForEach(recoveries) { recovery in
                        Button { onResume(recovery.draft) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Label(recovery.draft.subject.isEmpty ? "Unfinished message" : recovery.draft.subject, systemImage: "square.and.pencil")
                                    .foregroundStyle(palette.text).lineLimit(1)
                                Text(recovery.draft.to.isEmpty ? recovery.draft.from : recovery.draft.to)
                                    .font(.footnote).foregroundStyle(palette.muted).lineLimit(1)
                            }.padding(.vertical, 6)
                        }
                        .listRowBackground(palette.canvas)
                        .contextMenu {
                            Button("Delete local copy", systemImage: "trash", role: .destructive) { store.removeRecovery(recovery.draft, deletingFiles: true) }
                        }
                    }
                }.textCase(nil)
            }
            if preferences.groupMessagesByDay {
                ForEach(ThreadDay.group(threads)) { day in
                    Section {
                        if !collapsedDays.contains(day.id) {
                            rows(day.threads)
                        }
                    } header: {
                        dayHeader(day)
                    }
                    .textCase(nil)
                }
            } else {
                rows(threads)
            }

            if !searching, let sync = store.sync, sync.hasMore(place.folder, scope: place.scope) {
                // The folder's next page from Gmail, when the list gets here.
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .task(id: "\(place)-\(sync.cursor(place.folder, scope: place.scope))") { await sync.loadMore(place.folder, scope: place.scope) }
            }

            if store.sync?.loadingCache == true && threads.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
            if store.sync?.loadingCache != true && threads.isEmpty && (searching || recoveries.isEmpty) && !(store.sync?.hasMore(place.folder, scope: place.scope) ?? false) {
                ContentUnavailableView(
                    searching ? "No results" : "Nothing in \(place.folder.title)",
                    systemImage: searching ? "magnifyingglass" : place.folder.symbol,
                    description: Text(searching ? "Try other words, or from: and is:unread." : "")
                )
                .foregroundStyle(palette.muted)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .padding(.top, 80)
            }
        }
        .listStyle(.plain)
        .listSectionSeparator(.hidden, edges: .top)
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .onScrollPhaseChange { _, phase in
            if phase != .idle { swipedThread = nil }
        }
        .onChange(of: selecting) { _, _ in swipedThread = nil }
        .onChange(of: query) { _, _ in swipedThread = nil }
        .contentMargins(.bottom, 24, for: .scrollContent)
        // A mailbox whose sign-in was ended, under the title until it's back (or closed).
        .safeAreaInset(edge: .top, spacing: 0) { SignedOutBanners() }
        .searchable(text: $query, prompt: "Search")
        // Keep the header in place and return to a button instead of expanding
        // another search field while the keyboard is being dismissed.
        .searchPresentationToolbarBehavior(.avoidHidingContent)
        .searchToolbarBehavior(.minimize)
        .task(id: place) {
            swipedThread = nil
            collapsedDays.removeAll()
            selected.removeAll()
            selecting = false
            // Where a folder's list ends comes from its first page: fetch it now, while the list is at the top.
            await store.sync?.open(place.folder, scope: place.scope)
        }
        .task(id: query) {
            guard let sync = store.sync, !query.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let ids = await sync.search(query, scope: place.scope)
            found = (query, ids)
        }
        .refreshable {
            await store.sync?.syncAll()
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { swipedThread = nil; onDrawer() } label: {
                    Header(title: searching ? "Search" : place.folder.title, scope: scopeName)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows the mailboxes and folders")
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) {
                if selecting {
                    Button("Done", action: endSelection)
                } else {
                    Menu("More", systemImage: "ellipsis") {
                        Button("Select messages", systemImage: "checkmark.circle") { withAnimation(actionAnimation) { selecting = true } }
                            .disabled(threads.isEmpty)
                        Button("Mark all as read", systemImage: "envelope.open") {
                            for thread in threads where thread.unread { store.setRead(true, thread.id) }
                        }
                        .disabled(!threads.contains(where: \.unread))
                        Button("Settings", systemImage: "gearshape", action: onSettings)
                    }
                }
            }
            if selecting {
                ToolbarItem(placement: .bottomBar) {
                    Menu("\(selected.count) selected") {
                        Button(selected.count == threads.count ? "Deselect all" : "Select all") {
                            selected = selected.count == threads.count ? [] : Set(threads.map(\.id))
                        }
                    }
                }
                ToolbarSpacer(.flexible, placement: .bottomBar)
            } else {
                ToolbarSpacer(.flexible, placement: .bottomBar)
                DefaultToolbarItem(kind: .search, placement: .bottomBar)
                if session.agent.isOn { ToolbarSpacer(.fixed, placement: .bottomBar) }
            }
            if selecting || session.agent.isOn {
                ToolbarItem(id: "secondary-action", placement: .bottomBar) {
                    if selecting {
                        if place.folder == .trash || place.folder == .junk {
                            Button("Move to Inbox", systemImage: "tray.and.arrow.down") {
                                for id in selected { store.moveToInbox(id) }
                                endSelection()
                            }.disabled(selected.isEmpty)
                        } else {
                            Button("Archive", systemImage: "archivebox") { store.archive(selected); endSelection() }
                                .disabled(!selected.compactMap(store.thread).contains { $0.labels.contains("INBOX") })
                        }
                    } else {
                        Button(action: onAgent) { Label("Agent", image: "OtterAgent") }
                    }
                }
            }
            if selecting {
                ToolbarItem(id: "message-actions", placement: .bottomBar) {
                    Menu("Message actions", systemImage: "tag") {
                        Button("Mark as read", systemImage: "envelope.open") { for id in selected { store.setRead(true, id) }; endSelection() }
                        Button("Mark as unread", systemImage: "envelope.badge") { for id in selected { store.setRead(false, id) }; endSelection() }
                        if selected.compactMap(store.thread).contains(where: { !(store.mailbox($0.mailbox)?.labels.isEmpty ?? true) }) {
                            bulkLabels
                        }
                    }.disabled(selected.isEmpty)
                }
            }
            if selecting && place.folder != .trash {
                ToolbarItem(id: "primary-action", placement: .bottomBar) {
                    Button("Move to Trash", systemImage: "trash", role: .destructive) { store.trash(selected); endSelection() }
                        .disabled(selected.isEmpty)
                }
            }
        }
        .onChange(of: threads.map(\.id)) { _, ids in selected.formIntersection(ids) }
        .onChange(of: query) { _, _ in selected.removeAll() }
        .toolbarTitleDisplayMode(.inline)
        // Search and scroll minimization otherwise animate the same bar's insets.
        .minimizingNavigationBar(enabled: false)
    }

    /** The folder's threads, down to where its pages reached (so the next page adds to the bottom). */
    private var listed: [MailThread] {
        let threads = store.threads(in: place.folder, scope: place.scope)
        return store.sync?.listed(threads, in: place.folder) ?? threads
    }

    /** Here first, then what Gmail found. */
    private var results: [MailThread] {
        let local = store.search(query, scope: place.scope)
        guard found.query == query else { return local }
        let known = Set(local.map(\.id))
        let remote = found.ids.filter { !known.contains($0) }.compactMap(store.thread)
        return (local + remote).sorted { $0.latest.date > $1.latest.date }
    }

    private var recoveries: [RecoveredDraft] {
        guard place.folder == .drafts else { return [] }
        let shown = Set(store.shownMailboxes.map(\.email))
        return store.recoveredDrafts.filter { recovery in
            place.scope.map { recovery.draft.from == $0 } ?? shown.contains(recovery.draft.from)
        }
    }

    private var actionAnimation: Animation? { reduceMotion ? nil : .smooth(duration: 0.18) }

    private func endSelection() {
        withAnimation(actionAnimation) { selected.removeAll(); selecting = false }
    }

    private var bulkLabels: some View {
        Menu("Labels / folders", systemImage: "tag") {
            ForEach(store.shownMailboxes) { mailbox in
                let threads = selected.compactMap(store.thread).filter { $0.mailbox == mailbox.email }
                if !threads.isEmpty && !mailbox.labels.isEmpty {
                    Menu(mailbox.displayName) {
                        ForEach(mailbox.labels) { label in
                            let remove = threads.allSatisfy { $0.labels.contains(label.id) }
                            Button("\(remove ? "Remove" : mailbox.capabilities.multipleLabels ? "Add" : "Move to") \(label.name)") {
                                for thread in threads where thread.labels.contains(label.id) == remove {
                                    store.toggleLabel(label.id, thread.id)
                                }
                                endSelection()
                            }
                        }
                    }
                }
            }
        }
    }

    private var scopeName: String {
        place.scope.flatMap(store.mailbox)?.displayName ?? "All mailboxes"
    }

    private func rows(_ threads: [MailThread]) -> some View {
        ForEach(threads) { thread in
            row(thread, combined: place.scope == nil, divider: thread.id != threads.first?.id)
        }
    }

    private func dayHeader(_ day: ThreadDay) -> some View {
        let collapsed = collapsedDays.contains(day.id)
        return Button {
            if collapsed { collapsedDays.remove(day.id) }
            else { collapsedDays.insert(day.id) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2)
                Text(day.title).fontWeight(.medium)
                Spacer()
                Text("\(day.threads.count)").monospacedDigit()
                if day.unread > 0 {
                    Text("· \(day.unread) unread").foregroundStyle(palette.action)
                }
            }
            .font(.footnote)
            .foregroundStyle(palette.muted)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(day.title), \(day.threads.count) conversations, \(day.unread) unread")
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
        .accessibilityHint("Double tap to \(collapsed ? "expand" : "collapse") this day")
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
    }

    private func row(_ thread: MailThread, combined: Bool, divider: Bool) -> some View {
        Group {
            let content = ThreadRow(thread: thread, mailbox: combined ? store.mailbox(thread.mailbox) : nil)
            if selecting {
                Button {
                    if selected.contains(thread.id) { selected.remove(thread.id) }
                    else { selected.insert(thread.id) }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: selected.contains(thread.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selected.contains(thread.id) ? palette.action : palette.muted)
                        content
                    }
                }
                .buttonStyle(.plain)
                .accessibilityValue(selected.contains(thread.id) ? "Selected" : "Not selected")
            } else if thread.isDraft, let message = thread.messages.last {
                Button { onResume(.resume(message, in: thread)) } label: { content }
                    .buttonStyle(.plain)
            } else {
                NavigationLink(value: thread.id) { content }
                    .navigationLinkIndicatorVisibility(.hidden)
                    .matchedTransitionSource(id: thread.id, in: messageTransition)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 9)
        .background(
            palette.canvas.overlay {
                if preferences.dimReadMessages && !thread.unread && !thread.isDraft {
                    RoundedRectangle(cornerRadius: preferences.messageListStyle == .classic ? 8 : 0)
                        .fill(palette.text.opacity(0.04))
                        .padding(.horizontal, preferences.messageListStyle == .classic ? 4 : 0)
                        .padding(.vertical, preferences.messageListStyle == .classic ? 1 : 0)
                }
            }
            .overlay(alignment: .top) {
                if preferences.messageListStyle == .dividers && divider {
                    Rectangle().fill(palette.border).frame(height: 0.5)
                }
            }
        )
        .contextMenu {
            if !selecting { ThreadActions(thread: thread) }
        }
        .modifier(MailSwipeActions(
            id: thread.id, activeRow: $swipedThread,
            leading: selecting ? [] : [
                MailSwipeAction(title: thread.unread ? "Read" : "Unread", symbol: thread.unread ? "envelope.open" : "envelope.badge", tint: palette.focus) {
                    withAnimation(actionAnimation) { store.setRead(thread.unread, thread.id) }
                },
            ],
            trailing: selecting ? [] : trailingActions(thread)
        ))
        .listRowBackground(palette.canvas)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets())
    }

    private func trailingActions(_ thread: MailThread) -> [MailSwipeAction] {
        if place.folder == .trash || place.folder == .junk {
            return [
                MailSwipeAction(title: "Delete", symbol: "trash", tint: .red) {
                    withAnimation(actionAnimation) { store.deleteForever(thread.id) }
                },
                MailSwipeAction(title: "Inbox", symbol: "tray.and.arrow.down", tint: palette.focus) {
                    withAnimation(actionAnimation) { store.moveToInbox(thread.id) }
                },
            ]
        }
        var actions = [MailSwipeAction(title: "Trash", symbol: "trash", tint: .red) {
            withAnimation(actionAnimation) { store.trash(thread.id) }
        }]
        if thread.labels.contains("INBOX") {
            actions.append(MailSwipeAction(title: "Archive", symbol: "archivebox", tint: .indigo) {
                withAnimation(actionAnimation) { store.archive(thread.id) }
            })
        }
        return actions
    }

    /** "Inbox Personal": the folder, then where it is, quieter (Otter Code's wordmark). */
    private struct Header: View {
        @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
        let title: String
        let scope: String

        var body: some View {
            Text("\(Text(title).fontWeight(.semibold).foregroundStyle(palette.text)) \(Text(scope).foregroundStyle(palette.muted))")
                .font(.title3)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .fixedSize()
        }
    }
}

/** A thread's actions, for its context menu and the reader's menu. */
struct ThreadActions: View {
    @Environment(MailStore.self) private var store
    let thread: MailThread
    var onGone: () -> Void = {}

    var body: some View {
        Button(thread.unread ? "Mark as read" : "Mark as unread",
               systemImage: thread.unread ? "envelope.open" : "envelope.badge") {
            store.setRead(thread.unread, thread.id)
        }
        Button(thread.starred ? "Unstar" : "Star", systemImage: thread.starred ? "star.slash" : "star") {
            store.toggleStar(thread.id)
        }
        if let mailbox = store.mailbox(thread.mailbox), !mailbox.labels.isEmpty {
            Menu("Labels", systemImage: "tag") {
                ForEach(mailbox.labels) { label in
                    Toggle(label.name, isOn: Binding(
                        get: { thread.labels.contains(label.id) },
                        set: { _ in store.toggleLabel(label.id, thread.id) }
                    ))
                }
            }
            // A switch (the app's toggle style) can't sit in a menu; checkmarks can.
            .toggleStyle(.automatic)
        }
        Divider()
        if thread.labels.contains("INBOX") {
            Button("Archive", systemImage: "archivebox") { store.archive(thread.id); onGone() }
        }
        if thread.labels.contains("SPAM") || thread.labels.contains("TRASH") || !thread.labels.contains("INBOX") {
            Button("Move to Inbox", systemImage: "tray.and.arrow.down") { store.moveToInbox(thread.id); onGone() }
        }
        if !thread.labels.contains("SPAM") {
            Button("Report junk", systemImage: "xmark.bin") { store.markSpam(thread.id); onGone() }
        }
        if thread.labels.contains("TRASH") {
            Button("Delete forever", systemImage: "trash", role: .destructive) { store.deleteForever(thread.id); onGone() }
        } else {
            Button("Trash", systemImage: "trash", role: .destructive) { store.trash(thread.id); onGone() }
        }
    }
}
