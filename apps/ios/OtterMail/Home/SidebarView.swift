import SwiftUI

/**
 * The drawer, ChatGPT's sidebar: a page per mailbox, swiped through like
 * the desktop's mailbox tabs, each with its folders and labels; at the
 * bottom, a Compose pill with Settings beside it.
 */
struct SidebarView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Binding var place: Place
    let onSelect: (Place) -> Void
    let onCompose: () -> Void
    let onSettings: () -> Void

    /** The page shown: a mailbox's address. */
    @State private var page: String?

    private var pageAnimation: Animation? { reduceMotion ? nil : .smooth(duration: 0.2) }

    private var pages: [String] { store.shownMailboxes.map(\.email) }

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
                        folders(scope: key)
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
        .onAppear { page = place.scope }
        .onChange(of: place.scope) { _, scope in
            withAnimation(pageAnimation) { page = scope }
        }
        .onChange(of: page) { _, page in
            // Swiped to another mailbox: the list behind follows, to the same folder where it has one.
            guard let page, page != place.scope else { return }
            let same = store.mailbox(page)?.folders.contains(place.folder) == true
            place = Place(scope: page, folder: same ? place.folder : .inbox)
        }
    }

    /** Each mailbox: a tap or a swipe switches. */
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
        let selected = page == key
        return Button {
            withAnimation(pageAnimation) { page = key }
        } label: {
            HStack(spacing: 6) {
                if let mailbox = store.mailbox(key) {
                    MailboxMark(mailbox: mailbox, size: 16)
                    Text(mailbox.displayName)
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
    private func folders(scope: String) -> some View {
        let mailbox = store.mailbox(scope)
        return ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if let mailbox, mailbox.signedOut {
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(palette.warning)
                        Text(signedOutTitle(mailbox)).font(.subheadline).lineLimit(1)
                        Spacer(minLength: 8)
                        SignInAgainButton(mailbox: mailbox)
                    }
                    .foregroundStyle(palette.sidebarText)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 48)
                    .background(palette.sidebarSelected, in: .rect(cornerRadius: 12))
                    .padding(.bottom, 8)
                }
                ForEach(mailbox?.folders ?? [], id: \.self) { folder in
                    row(folder, scope: scope)
                }
                let labels = mailbox?.labels ?? []
                switch mailbox?.provider {
                case .outlook:
                    labelSection("Folders", labels: labels.filter { $0.id.hasPrefix(OutlookFolders.folderPrefix) }, scope: scope)
                    labelSection("Categories", labels: labels.filter { $0.id.hasPrefix(OutlookFolders.categoryPrefix) }, scope: scope, flat: true)
                case .imap: labelSection("Folders", labels: labels, scope: scope)
                default: labelSection("Labels", labels: labels, scope: scope)
                }
            }
            .padding(.horizontal, 12)
        }
        .scrollIndicators(.hidden)
        .contentMargins(.top, 4, for: .scrollContent)
        .contentMargins(.bottom, 126, for: .scrollContent)
        // iOS's soft edge under the chips, only once rows scroll there.
        .scrollEdgeEffectStyle(.soft, for: .top)
        // Rows fade only as they slide under the status line and Compose (at rest the last one sits above them).
        .mask {
            VStack(spacing: 0) {
                Color.black
                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 28)
                Color.clear.frame(height: 112)
            }
            .ignoresSafeArea()
        }
    }

    @ViewBuilder
    private func labelSection(_ title: String, labels: [MailLabel], scope: String, flat: Bool = false) -> some View {
        if !labels.isEmpty {
            Text(title)
                .font(.footnote)
                .foregroundStyle(palette.sidebarMuted)
                .padding(.horizontal, 12)
                .padding(.top, 20)
                .padding(.bottom, 4)
            ForEach(labels) { label in
                row(.label(id: label.id, name: label.name), scope: scope, color: label.color, indent: flat ? 0 : label.depth)
            }
        }
    }

    private func row(_ folder: Folder, scope: String, color: String? = nil, indent: Int = 0) -> some View {
        let selected = place.scope == scope && place.folder == folder
        let count = store.badge(in: folder, scope: scope)
        let mailbox = store.mailbox(scope)
        return Button {
            onSelect(Place(scope: scope, folder: folder))
        } label: {
            HStack(spacing: 12) {
                // Icons stay quiet, as on the desktop, until their row is picked.
                Image(systemName: folder.symbol(in: mailbox))
                    .font(.system(size: 16))
                    .foregroundStyle(color.map(Color.init(hex:)) ?? (selected ? palette.sidebarText : palette.sidebarMuted))
                    .frame(width: 22)
                Text(folder.title(in: mailbox))
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
        VStack(alignment: .leading, spacing: 10) {
            SyncStatusLine(scope: page ?? place.scope)
                .padding(.horizontal, 4)
            footerButtons
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    private var footerButtons: some View {
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
    }
}
