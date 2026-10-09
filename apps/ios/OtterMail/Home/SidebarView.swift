import SwiftUI

/**
 * The drawer, ChatGPT's sidebar: a page per mailbox (All first), swiped
 * through like the desktop's mailbox pages, each with its folders and
 * labels; at the bottom, a Compose pill with Settings beside it.
 */
struct SidebarView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Binding var place: Place
    let onSelect: (Place) -> Void
    let onCompose: () -> Void
    let onSettings: () -> Void

    /** The page shown: a mailbox's address, or `Self.all`. */
    @State private var page: String?
    private static let all = "__all__"

    private var pageAnimation: Animation? { reduceMotion ? nil : .smooth(duration: 0.2) }

    private var pages: [String] {
        (store.offersCombined ? [Self.all] : []) + store.shownMailboxes.map(\.email)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The desktop's wordmark: "Mail" quieter.
            Text("\(Text("Otter").foregroundStyle(palette.sidebarText)) \(Text("Mail").foregroundStyle(palette.sidebarMuted))")
                .font(.title3.weight(.semibold))
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .padding(.bottom, 14)

            chips
                .padding(.bottom, 14)

            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 0) {
                    ForEach(pages, id: \.self) { key in
                        folders(scope: key == Self.all ? nil : key)
                            .containerRelativeFrame(.horizontal)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $page)
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .bottom) { footer }
        .background(palette.sidebar)
        .onAppear { page = place.scope ?? Self.all }
        .onChange(of: place.scope) { _, scope in
            withAnimation(pageAnimation) { page = scope ?? Self.all }
        }
        .onChange(of: page) { _, page in
            // Swiped to another mailbox: the list behind follows.
            guard let page else { return }
            let scope = page == Self.all ? nil : page
            guard scope != place.scope else { return }
            place = Place(scope: scope, folder: scope == nil && place.folder.isLabel ? .inbox : place.folder)
        }
    }

    /** All mailboxes, then each one: a tap or a swipe switches. */
    private var chips: some View {
        ScrollViewReader { reader in
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(pages, id: \.self) { key in
                        chip(key)
                    }
                }
                .padding(.horizontal, 24)
            }
            .scrollIndicators(.hidden)
            .onChange(of: page) { _, page in
                withAnimation(pageAnimation) { reader.scrollTo(page, anchor: .center) }
            }
        }
    }

    private func chip(_ key: String) -> some View {
        let selected = (page ?? Self.all) == key
        let mailbox = store.mailbox(key)
        return Button {
            withAnimation(pageAnimation) { page = key }
        } label: {
            HStack(spacing: 6) {
                if let mailbox {
                    MailboxMark(mailbox: mailbox, size: 16)
                    Text(mailbox.displayName)
                } else {
                    Image(systemName: "square.stack")
                    Text("All")
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(selected ? palette.sidebarText : palette.sidebarMuted)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(selected ? palette.sidebarSelected : .clear, in: .capsule)
        }
        .buttonStyle(.plain)
        .id(key)
    }

    /** A mailbox's page: its folders, then its labels. */
    private func folders(scope: String?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if let mailbox = scope.flatMap(store.mailbox), mailbox.signedOut {
                    Label("Sign in to \(mailbox.email) in Settings › Mailboxes", systemImage: "exclamationmark.circle")
                        .font(.subheadline)
                        .foregroundStyle(palette.warning)
                        .padding(12)
                }
                // Important is Gmail's sorting, and Outlook's high importance; IMAP has neither.
                let sorts = scope.flatMap(store.mailbox)?.provider != .imap
                ForEach(Folder.system.filter { sorts || $0 != .important }, id: \.self) { folder in
                    row(folder, scope: scope)
                }
                let labels = scope.flatMap(store.mailbox)?.labels ?? []
                if !labels.isEmpty {
                    Text("Labels")
                        .font(.footnote)
                        .foregroundStyle(palette.sidebarMuted)
                        .padding(.horizontal, 12)
                        .padding(.top, 20)
                        .padding(.bottom, 4)
                    ForEach(labels) { label in
                        row(.label(id: label.id, name: label.name), scope: scope, color: label.color, indent: label.depth)
                    }
                }
            }
            .padding(.horizontal, 12)
        }
        .scrollIndicators(.hidden)
        .contentMargins(.top, 4, for: .scrollContent)
        .contentMargins(.bottom, 96, for: .scrollContent)
        // iOS's soft edge under the chips, only once rows scroll there.
        .scrollEdgeEffectStyle(.soft, for: .top)
        // Rows fade only as they slide under Compose (at rest the last one sits above it).
        .mask {
            VStack(spacing: 0) {
                Color.black
                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 28)
                Color.clear.frame(height: 60)
            }
            .ignoresSafeArea()
        }
    }

    private func row(_ folder: Folder, scope: String?, color: String? = nil, indent: Int = 0) -> some View {
        let selected = place.scope == scope && place.folder == folder
        let count = store.badge(in: folder, scope: scope)
        return Button {
            onSelect(Place(scope: scope, folder: folder))
        } label: {
            HStack(spacing: 12) {
                // Icons stay quiet, as on the desktop, until their row is picked.
                Image(systemName: folder.symbol)
                    .font(.system(size: 16))
                    .foregroundStyle(color.map(Color.init(hex:)) ?? (selected ? palette.sidebarText : palette.sidebarMuted))
                    .frame(width: 22)
                Text(folder.title)
                    .font(.callout)
                    .foregroundStyle(palette.sidebarText)
                    .lineLimit(1)
                Spacer()
                if count > 0 {
                    Text("\(count)")
                        .font(.footnote)
                        .foregroundStyle(palette.sidebarMuted)
                        .monospacedDigit()
                }
            }
            .padding(.leading, 12 + CGFloat(indent) * 20)
            .padding(.trailing, 12)
            .frame(height: 44)
            .background(selected ? palette.sidebarSelected : .clear, in: .rect(cornerRadius: 12))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        HStack {
            Button(action: onCompose) {
                Label("Compose", systemImage: "square.and.pencil")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.sidebarText)
                    .padding(.horizontal, 18)
                    .frame(height: 44)
                    .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .capsule)
            Spacer()
            Button("Settings", systemImage: "gearshape", action: onSettings)
                .labelStyle(.iconOnly)
                .font(.system(size: 17))
                .frame(width: 44, height: 44)
                .foregroundStyle(palette.sidebarText)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }
}

extension Folder {
    var isLabel: Bool {
        if case .label = self { true } else { false }
    }
}
