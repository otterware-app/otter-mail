import Foundation
import Testing
import WebKit
@testable import Otter_Mail

@MainActor
struct PerformanceTests {
    private func mailbox() -> Mailbox {
        Mailbox(email: "test@example.com", name: "Test", displayName: "Test", color: "#336699", signature: "", labels: [])
    }

    private func thread(_ id: Int, text: String = "Hello") -> MailThread {
        let message = Message(id: "\(id)", from: Person(name: "Sender", email: "sender@example.com"), to: [], cc: [],
                              date: Date(timeIntervalSince1970: Double(id)), text: text, html: nil, attachments: [],
                              unread: true, starred: false, draft: false, headers: [:])
        return MailThread(id: "\(id)", mailbox: mailbox().email, subject: "Test", labels: ["INBOX"], messages: [message])
    }

    @Test func previewsAreBoundedAndKeepReplyText() {
        #expect(thread(0, text: " Hello \n\n world \n> quoted text").latest.snippet == "Hello world")
        #expect(thread(0, text: "[Visit the shop](https://example.com/tracking) **Hello** there!\n> quoted text").latest.snippet == "Visit the shop Hello there!")
        #expect(thread(0, text: "Thanks!\n\nOn Tuesday, Sam wrote:\n> original message").latest.snippet == "Thanks!")
        #expect(thread(0, text: String(repeating: "🦦", count: 100_000)).latest.snippet == String(repeating: "🦦", count: 240))
        #expect(thread(0, text: "").latest.snippet.isEmpty)
    }

    @Test func cachePreservesNewestMailAndOrdersDeletionAfterWrites() async throws {
        let folder = URL.temporaryDirectory.appending(path: "MailCacheTests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = MailCache(folder: folder)
        var state = MailboxState()
        state.historyID = "123"
        cache.save([.init(mailbox: mailbox(), state: state, threads: (0..<450).map { thread($0) })])
        let loaded = try #require(await cache.load([mailbox().email]).first)
        #expect(loaded.threads.count == 400)
        #expect(loaded.threads.first?.id == "449")
        #expect(loaded.threads.last?.id == "50")
        #expect(loaded.state.historyID == "123")
        cache.save([loaded])
        cache.remove(mailbox().email)
        #expect(await cache.load([mailbox().email]).isEmpty)
        cache.save([loaded])
        cache.removeAll()
        #expect(await cache.load([mailbox().email]).isEmpty)
    }

    @Test func cacheRestoreDoesNotResurrectRemovedMailOrOverwriteMailboxEdits() async throws {
        let folder = URL.temporaryDirectory.appending(path: "MailRestoreTests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = MailCache(folder: folder)
        let snapshot = MailCache.Snapshot(mailbox: mailbox(), state: MailboxState(), threads: [thread(1)])
        cache.save([snapshot])
        let store = MailStore(preferences: Preferences(), mailboxes: [mailbox()])
        let sync = MailSync(store: store, google: GoogleAuth(), cache: cache)
        sync.loadCache(for: [mailbox().email])
        var renamed = mailbox()
        renamed.displayName = "Renamed while loading"
        store.upsert(mailbox: renamed)
        await sync.waitForCache()
        #expect(store.mailboxes.first?.displayName == renamed.displayName)
        #expect(store.threads.count == 1)
        #expect(!sync.loadingCache)

        let empty = MailStore(preferences: Preferences(), mailboxes: [mailbox()])
        let cancelled = MailSync(store: empty, google: GoogleAuth(), cache: cache)
        cancelled.loadCache(for: [mailbox().email])
        cancelled.forgetAll()
        await cancelled.waitForCache()
        #expect(empty.threads.isEmpty)
        #expect(await cache.load([mailbox().email]).isEmpty)
    }

    @Test(.timeLimit(.minutes(1))) func inlineImagesLoadThroughWebKitWithoutDelayingText() async throws {
        let png = try #require(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII="))
        let attachment = Attachment(id: "image", filename: "image.png", mimeType: "image/png", size: png.count, contentID: "logo@example.com")
        let gate = ImageGate()
        defer { gate.release() }
        var configuration = WebPage.Configuration()
        configuration.urlSchemeHandlers[try #require(URLScheme("cid"))] = InlineImages(images: [attachment]) { _ in
            await gate.wait()
            return png
        }
        let page = WebPage(configuration: configuration)
        for try await event in page.load(html: "<p>Message text</p><img id='inline' src='cid:logo%40example.com'>", baseURL: URL(string: "about:blank")!) {
            if event == .committed {
                let text = try await page.callJavaScript("""
                    return new Promise(resolve => {
                        const read = () => resolve(document.querySelector('p').textContent);
                        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', read, { once: true });
                        else read();
                    });
                    """) as? String
                #expect(text == "Message text")
                let width = try await page.callJavaScript("return document.getElementById('inline').naturalWidth") as? Double
                #expect(width == 0)
                gate.release()
            }
            if event == .finished { break }
        }
        let width = try await page.callJavaScript("return document.getElementById('inline').naturalWidth") as? Double
        #expect(width == 1)
    }
}

@MainActor
private final class ImageGate {
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() {
        released = true
        continuation?.resume()
        continuation = nil
    }
}
