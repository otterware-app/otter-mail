import SwiftUI

/** Where the user is: a mailbox (or all of them) and a folder in it. */
struct Place: Hashable {
    /** A mailbox's address; nil = all mailboxes. */
    var scope: String?
    var folder: Folder = .inbox
}

/**
 * The app's frame: iOS's tabs, for the mail, the agent (the AI workspace:
 * its chats, every device's) and search. The mail is ChatGPT's: the list,
 * with the sidebar drawer under it. A swipe in from the left edge, or a tap
 * on the list's title, slides the list aside.
 */
struct HomeView: View {
    enum Tab: Hashable { case mail, agent, search }

    @Environment(MailStore.self) private var store
    @Environment(Session.self) private var session
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var messageTransition
    @Namespace private var searchTransition

    @State private var tab = Tab.mail
    @State private var place = Place()
    @State private var path: [String] = []
    @State private var drawerOpen = false
    @State private var draft: Draft?
    @State private var settingsOpen = false
    @State private var query = ""
    @State private var searchPath: [String] = []
    @State private var chatsOpen = false

    /** An agent here, or the account's chats to read (Claude and Codex ones too). */
    private var showsAgent: Bool { session.agent.isOn || session.user != nil }

    var body: some View {
        TabView(selection: $tab) {
            SwiftUI.Tab("Mail", systemImage: "envelope", value: Tab.mail) { mail }
            SwiftUI.Tab("Agent", image: "OtterAgent", value: Tab.agent) {
                // ChatGPT's: the chats in a drawer under the chat, a swipe from the left edge.
                Drawer(isOpen: $chatsOpen, canOpen: true) {
                    ChatHistory(shown: chatsOpen, onClose: { setChats(open: false) })
                } content: {
                    NavigationStack {
                        AgentView(onSettings: { settingsOpen = true }, onHistory: { setChats(open: true) })
                    }
                }
                .toolbarVisibility(chatsOpen ? .hidden : .automatic, for: .tabBar)
            }
            .hidden(!showsAgent)
            SwiftUI.Tab(value: Tab.search, role: .search) { search }
        }
        // Search on its own at the bar's end, as in Photos: choosing it starts the search.
        .tabViewSearchActivation(.searchTabSelection)
        .tabBarMinimizeBehavior(.onScrollDown)
        .onChange(of: showsAgent) { _, shows in
            if !shows && tab == .agent { tab = .mail }
        }
        .onChange(of: store.shownMailboxes.map(\.email)) { _, shown in
            // The mailbox shown was turned off or removed: fall back to what's left.
            if let scope = place.scope, !shown.contains(scope) {
                place = Place(scope: store.offersCombined ? nil : shown.first)
            } else if place.scope == nil, !store.offersCombined {
                place.scope = shown.first
            }
        }
        .onAppear {
            if !store.offersCombined { place.scope = store.shownMailboxes.first?.email }
        }
        .onChange(of: session.opening, initial: true) { _, _ in openNotification() }
        .onChange(of: store.sync?.loadingCache) { _, loading in
            if loading == false { openNotification() }
        }
        .sheet(item: $draft) { draft in
            ComposeView(draft: store.recover(draft))
        }
        .sheet(isPresented: $settingsOpen) {
            SettingsView()
        }
    }

    /** The mail: the list (and the reader), the sidebar's drawer under it. */
    private var mail: some View {
        Drawer(isOpen: $drawerOpen, canOpen: path.isEmpty) {
            SidebarView(
                place: $place,
                onSelect: { select($0) },
                onCompose: { compose() },
                onSettings: { settingsOpen = true }
            )
        } content: {
            NavigationStack(path: $path) {
                ThreadListView(
                    place: place,
                    messageTransition: messageTransition,
                    drawerOpen: drawerOpen,
                    onDrawer: { setDrawer(open: true) },
                    onSettings: { settingsOpen = true },
                    onResume: { draft = $0 }
                )
                .navigationDestination(for: String.self) { id in
                    let reader = ThreadView(threadID: id, place: place, path: $path, draft: $draft)
                    if reduceMotion {
                        reader
                    } else {
                        reader.navigationTransition(.zoom(sourceID: id, in: messageTransition))
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 8) {
                if let action = store.undoAction {
                    HStack {
                        Text(action.title).font(.subheadline).lineLimit(2)
                        Spacer(minLength: 12)
                        Button("Undo") { store.undo() }.fontWeight(.semibold)
                            .accessibilityHint("Restores the conversations to their previous folders")
                    }
                    .foregroundStyle(palette.text)
                    .padding(16)
                    .background(palette.raised, in: .rect(cornerRadius: 18))
                    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(palette.border))
                    .padding(.horizontal, 16)
                    .id(action.id)
                }
            }
        }
    }

    /** Search: what it finds in the mailbox the mail shows. */
    private var search: some View {
        NavigationStack(path: $searchPath) {
            ThreadListView(
                place: place,
                messageTransition: searchTransition,
                query: query,
                searchTab: true,
                onDrawer: {
                    tab = .mail
                    setDrawer(open: true)
                },
                onSettings: { settingsOpen = true },
                onResume: { draft = $0 }
            )
            .navigationDestination(for: String.self) { id in
                let reader = ThreadView(threadID: id, place: place, path: $searchPath, draft: $draft)
                if reduceMotion {
                    reader
                } else {
                    reader.navigationTransition(.zoom(sourceID: id, in: searchTransition))
                }
            }
        }
        .searchable(text: $query, prompt: "Search")
    }

    private func select(_ next: Place) {
        place = next
        path = []
        setDrawer(open: false)
    }

    private func compose(to: String = "") {
        let mailbox = place.scope.flatMap(store.mailbox) ?? store.shownMailboxes.first
        guard let mailbox else { return }
        setDrawer(open: false)
        draft = .new(from: mailbox, to: to)
    }

    private func openNotification() {
        guard let destination = session.opening else { return }
        Task {
            await session.prepareNotification(destination)
            guard session.opening == destination else { return }
            session.opening = nil
            guard destination.userId == nil || destination.userId == session.user?.id else { return }
            if let email = destination.email, let mailbox = store.mailboxes.first(where: { $0.email.lowercased() == email.lowercased() }) {
                place = Place(scope: mailbox.email)
            }
            setDrawer(open: false)
            tab = .mail
            if let thread = destination.thread, let loaded = store.thread(thread),
               destination.email == nil || loaded.mailbox.lowercased() == destination.email?.lowercased() {
                path = [thread]
            } else { path = [] }
        }
    }

    private func setDrawer(open: Bool) {
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.2)) { drawerOpen = open }
    }

    private func setChats(open: Bool) {
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.2)) { chatsOpen = open }
    }
}

/**
 * A sidebar under the screen, which slides aside to show it: the mail's
 * mailboxes, the agent's chats. Drag updates move these already-built views
 * instead of rebuilding the screen per gesture event.
 */
struct Drawer<Sidebar: View, Content: View>: View {
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var isOpen: Bool
    let canOpen: Bool
    @ViewBuilder var sidebar: Sidebar
    @ViewBuilder var content: Content
    @State private var drag: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            let width = min(geometry.size.width - 64, 340)
            let offset = min(max((isOpen ? width : 0) + drag, 0), width)
            ZStack(alignment: .leading) {
                sidebar.frame(width: width).opacity(offset / width)
                content
                    .clipShape(.rect(cornerRadius: offset > 0 ? 44 : 0))
                    .overlay {
                        if isOpen {
                            Color.black.opacity((colorScheme == .dark ? 0.3 : 0.08) * offset / width)
                                .clipShape(.rect(cornerRadius: 44))
                                .onTapGesture { withAnimation(reduceMotion ? nil : .smooth(duration: 0.2)) { isOpen = false } }
                                .gesture(gesture(width: width))
                        }
                    }
                    .offset(x: offset)
                    .ignoresSafeArea()
                // Edge-only, leaving row actions and the reader's back gesture to the system.
                if !isOpen && canOpen {
                    Color.clear.frame(width: 20).frame(maxHeight: .infinity)
                        .contentShape(.rect)
                        .gesture(gesture(width: width))
                        .ignoresSafeArea()
                }
            }
            .background(palette.sidebar)
        }
    }

    private func gesture(width: CGFloat) -> some Gesture {
        // The panel moves, so translations must be measured in screen coordinates.
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { value in drag = value.translation.width }
            .onEnded { value in
                let open = (isOpen ? width : 0) + value.predictedEndTranslation.width > width / 2
                withAnimation(reduceMotion ? nil : .interpolatingSpring(duration: 0.2, bounce: 0)) {
                    isOpen = open
                    drag = 0
                }
            }
    }
}

/** iOS 27 lets navigation give space back to the mail while scrolling. */
extension View {
    @ViewBuilder
    func minimizingNavigationBar(enabled: Bool = true) -> some View {
        if #available(iOS 27.0, *) {
            toolbarMinimizationBehavior(enabled ? .onScrollDown : .never, for: .navigationBar)
        } else {
            self
        }
    }
}
