import Foundation
import Network

/**
 * A connection to a mail server (IMAP or SMTP), TLS by the system, read a
 * line or a literal at a time.
 *
 * TLS from the start (993, 465) runs over Network.framework's NWConnection.
 * STARTTLS (143, 587) upgrades a plaintext connection mid-stream, which an
 * NWConnection can't do: its protocol stack is fixed when it starts. Apple's
 * answer for STARTTLS is URLSessionStreamTask, whose `startSecureConnection()`
 * begins TLS on the open connection, so those servers go through it.
 *
 * Debug builds trust any certificate from localhost (the test server,
 * GreenMail or Dovecot in Docker); release builds trust only the system's.
 */
nonisolated final class MailSocket {
    let transport: any MailTransport
    private var buffer = Data()
    private var literalLimit = Self.maxLiteral

    private init(_ transport: any MailTransport) {
        self.transport = transport
    }

    /** Connects; STARTTLS servers start in plaintext until `startTLS()`. */
    static func open(_ server: MailServer, maxResponseBytes: Int = maxLiteral) async throws -> MailSocket {
        let transport: any MailTransport = switch server.security {
        case .tls: NWTransport(host: server.host, port: server.port)
        case .starttls: StreamTransport(host: server.host, port: server.port)
        }
        try await withTaskCancellationHandler { try await transport.start() } onCancel: { transport.close() }
        try Task.checkCancellation()
        let socket = MailSocket(transport)
        socket.literalLimit = maxResponseBytes
        return socket
    }

    /** The longest line read (literals aside), and the most an IMAP response's literals may carry. */
    static let maxLine = 1 << 20
    static let maxLiteral = 100 << 20

    /** A line, without its CRLF. */
    func readLine() async throws -> Data {
        while true {
            if let end = buffer.firstRange(of: Data("\r\n".utf8)) {
                let line = buffer[buffer.startIndex..<end.lowerBound]
                guard line.count <= Self.maxLine else { throw ImapError.protocolError("The mail server sent a line too long to read.") }
                buffer = Data(buffer[end.upperBound...])
                return Data(line)
            }
            guard buffer.count <= Self.maxLine else { throw ImapError.protocolError("The mail server sent a line too long to read.") }
            buffer.append(try await transport.receive())
        }
    }

    /** Exactly `count` bytes (an IMAP literal). */
    func read(_ count: Int) async throws -> Data {
        guard count <= literalLimit else { throw ImapError.protocolError("The mail server sent too much at once.") }
        while buffer.count < count { buffer.append(try await transport.receive()) }
        let bytes = buffer.prefix(count)
        buffer = Data(buffer.dropFirst(count))
        return Data(bytes)
    }

    func write(_ text: String) async throws { try await transport.send(Data(text.utf8)) }
    func write(_ data: Data) async throws { try await transport.send(data) }

    /** Upgrades to TLS (after the server's go-ahead to STARTTLS). */
    func startTLS() async throws {
        buffer = Data()
        try await transport.startTLS()
    }

    func close() { transport.close() }
}

nonisolated protocol MailTransport: AnyObject, Sendable {
    func start() async throws
    /** Some bytes; throws once the connection is closed. */
    func receive() async throws -> Data
    func send(_ data: Data) async throws
    func startTLS() async throws
    func close()
}

nonisolated private func isLocal(_ host: String) -> Bool {
    ["localhost", "127.0.0.1", "::1"].contains(host.lowercased())
}

/** TLS from the first byte, over NWConnection. */
nonisolated private final class NWTransport: MailTransport, @unchecked Sendable {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "dev.otterware.mail.socket")

    init(host: String, port: Int) {
        let tls = NWProtocolTLS.Options()
        #if DEBUG
        if isLocal(host) {
            sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, _, complete in complete(true) }, queue)
        }
        #endif
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 15
        connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: UInt16(clamping: port)) ?? .imaps,
            using: NWParameters(tls: tls, tcp: tcp)
        )
    }

    func start() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            // State changes all come on `queue`, so this needs no lock.
            final class Once: @unchecked Sendable { var done = false }
            let once = Once()
            let finish = { @Sendable (error: Error?) in
                guard !once.done else { return }
                once.done = true
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
            connection.stateUpdateHandler = { [connection] state in
                switch state {
                case .ready: finish(nil)
                // Unreachable, refused or a bad certificate: fail now rather than wait for the network.
                case .waiting(let error), .failed(let error):
                    finish(error)
                    connection.cancel()
                case .cancelled: finish(ImapError.closed)
                default: break
                }
            }
            connection.start(queue: queue)
        }
    }

    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, _, error in
                if let data, !data.isEmpty {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? ImapError.closed)
                }
            }
        }
    }

    func send(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }

    func startTLS() async throws { throw ImapError.protocolError("Already using TLS.") }

    func close() { connection.cancel() }
}

/** Plaintext until STARTTLS, over URLSessionStreamTask. */
nonisolated private final class StreamTransport: NSObject, MailTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private let host: String
    private var session: URLSession!
    private var task: URLSessionStreamTask!

    init(host: String, port: Int) {
        self.host = host
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        task = session.streamTask(withHostName: host, port: port)
    }

    func start() async throws { task.resume() }

    func receive() async throws -> Data {
        let (data, _) = try await task.readData(ofMinLength: 1, maxLength: 65_536, timeout: 0)
        guard let data, !data.isEmpty else { throw ImapError.closed }
        return data
    }

    func send(_ data: Data) async throws { try await task.write(data, timeout: 0) }

    /** TLS begins once pending reads and writes are done; its errors come with the next read. */
    func startTLS() async throws { task.startSecureConnection() }

    func close() {
        task.cancel()
        session.invalidateAndCancel()
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        #if DEBUG
        if isLocal(host), let trust = challenge.protectionSpace.serverTrust {
            return (.useCredential, URLCredential(trust: trust))
        }
        #endif
        return (.performDefaultHandling, nil)
    }
}
