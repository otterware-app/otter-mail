import SwiftUI

/**
 * One thread, three lines, as the desktop lists them: who (the unread dot
 * before) and when, the subject, then a line of the latest message. List
 * styling and read backgrounds live in ThreadListView.
 */
struct ThreadRow: View {
    @Environment(\.palette) private var palette
    @Environment(Preferences.self) private var preferences
    let thread: MailThread
    /** How the mailbox marks mail (`Mailbox.mark`): a star, or a flag. */
    var mark = "star"

    var body: some View {
        let latest = thread.latest
        let unread = thread.unread
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                if unread && !preferences.dimReadMessages {
                    Circle().fill(palette.action).frame(width: 7, height: 7)
                }
                Text(senders)
                    .font(.subheadline)
                    .foregroundStyle(palette.text.opacity(0.72))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if thread.starred {
                    Image(systemName: "\(mark).fill")
                        .font(.caption2)
                        .foregroundStyle(palette.text)
                }
                if thread.hasAttachments {
                    Image(systemName: "paperclip")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
                if thread.messages.count > 1 {
                    Text("\(thread.messages.count)")
                        .font(.footnote)
                        .foregroundStyle(palette.muted)
                        .monospacedDigit()
                }
                Text(RelativeTime.short(latest.date))
                    .font(.footnote)
                    .foregroundStyle(palette.muted)
                    .monospacedDigit()
            }

            Text(thread.subject)
                .font(.subheadline.weight(unread ? .semibold : .medium))
                .foregroundStyle(palette.text)
                .lineLimit(1)

            Text(thread.isDraft ? "Draft · \(latest.snippet)" : latest.snippet)
                .font(.subheadline)
                .foregroundStyle(palette.muted.opacity(preferences.messageListStyle == .dividers ? 1 : 0.8))
                .lineLimit(1)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    /** "Maya, José, me": who wrote, in order. */
    private var senders: String {
        var names: [String] = []
        for message in thread.messages where !message.draft {
            let name = message.from.isAddress(thread.mailbox)
                ? "me"
                : message.from.label.split(separator: " ").first.map(String.init) ?? message.from.label
            if !names.contains(name) { names.append(name) }
        }
        if names.count == 1, names[0] != "me", let only = thread.messages.first(where: { !$0.draft }) {
            return only.from.label
        }
        return names.isEmpty ? "Draft" : names.joined(separator: ", ")
    }
}

/** A mailbox's mark: a rounded square in its color with its initial (Otter Code's project mark). */
struct MailboxMark: View {
    let mailbox: Mailbox
    var size: CGFloat = 16

    var body: some View {
        Text(mailbox.displayName.prefix(1).uppercased())
            .font(.system(size: size * 0.6, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color(hex: mailbox.color), in: .rect(cornerRadius: size * 0.28))
            .accessibilityLabel(mailbox.displayName)
    }
}

/** The sender's initial on a color picked from the address, the desktop's tile (sender-avatar.tsx). */
struct SenderAvatar: View {
    let person: Person
    var size: CGFloat = 32

    var body: some View {
        Text(person.label.prefix(1).uppercased())
            .font(.system(size: size * 0.42, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color, in: .rect(cornerRadius: size * 0.22))
            .accessibilityHidden(true)
    }

    /** The desktop's hue for the address, at hsl(h 48% 52%) (as hue, saturation and brightness). */
    private var color: Color {
        var hash: Int32 = 0
        for unit in person.email.trimmingCharacters(in: .whitespaces).lowercased().utf16 {
            hash = hash &* 31 &+ Int32(unit)
        }
        let hue = ((Int(hash) % 360) + 360) % 360
        return Color(hue: Double(hue) / 360, saturation: 0.614, brightness: 0.75)
    }
}

enum RelativeTime {
    /** "14:05" today, "Tue" this week, "12 Sep" this year, else "12/09/25". */
    static func short(_ date: Date, now: Date = .now) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 6 {
            return date.formatted(.dateTime.weekday(.abbreviated))
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.day().month(.abbreviated))
        }
        return date.formatted(date: .numeric, time: .omitted)
    }
}

/** Local calendar days, newest first, shared by inbox and search results. */
struct ThreadDay: Identifiable {
    let id: Date
    let threads: [MailThread]
    var unread: Int { threads.filter(\.unread).count }

    var title: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(id) { return "Today" }
        if calendar.isDateInYesterday(id) { return "Yesterday" }
        if calendar.isDate(id, equalTo: .now, toGranularity: .year) {
            return id.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        return id.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year())
    }

    static func group(_ threads: [MailThread], calendar: Calendar = .current) -> [ThreadDay] {
        Dictionary(grouping: threads) { calendar.startOfDay(for: $0.latest.date) }
            .map { ThreadDay(id: $0.key, threads: $0.value) }
            .sorted { $0.id > $1.id }
    }
}
