import Foundation

/**
 * Mail's encodings, for what IMAP hands over as it was sent: header words
 * (RFC 2047), transfer encodings (quoted-printable, base64), charsets, and
 * IMAP's own modified UTF-7 for folder names (RFC 3501 §5.1.3).
 */
nonisolated enum MailDecoding {
    /** Plain display text for snippets: keep link labels and words, not Markdown destinations or styling. */
    static func preview(_ value: String, limit: Int = 240) -> String {
        var text = String(value.prefix(4096))
        // Some text alternatives put whitespace between a link label and its URL.
        text = text.replacingOccurrences(of: #"(\[[^\]\n]+\])\s+\(\s*(?=https?://|mailto:)"#,
            with: "$1(", options: .regularExpression)
        // Gmail can cut its snippet in the middle of the last link destination.
        text = text.replacingOccurrences(of: #"\[([^\]\n]+)\]\(\s*(?:https?://|mailto:)[^\s)]*$"#,
            with: "$1", options: .regularExpression)
        if let rendered = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            text = String(rendered.characters)
        }
        return String(text.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(limit))
    }

    // ── Bodies ───────────────────────────────────────────────────────────────

    /** A part's bytes, undoing its Content-Transfer-Encoding. */
    static func transfer(_ data: Data, encoding: String) -> Data {
        switch encoding.lowercased() {
        case "base64": base64(String(decoding: data, as: UTF8.self))
        case "quoted-printable": quotedPrintable(data)
        default: data
        }
    }

    /** Text in its charset (UTF-8 when unsaid; Windows-1252 when the bytes lie). */
    static func text(_ data: Data, charset: String?) -> String {
        if let charset {
            let cf = CFStringConvertIANACharSetNameToEncoding(charset.trimmingCharacters(in: .whitespaces) as CFString)
            if cf != kCFStringEncodingInvalidId,
               let text = String(data: data, encoding: String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cf))) {
                return text
            }
        }
        return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .windowsCP1252) ?? String(decoding: data, as: UTF8.self)
    }

    static func base64(_ text: String) -> Data {
        var clean = text.filter { !$0.isWhitespace }
        clean += String(repeating: "=", count: (4 - clean.count % 4) % 4)
        return Data(base64Encoded: clean, options: .ignoreUnknownCharacters) ?? Data()
    }

    /** Quoted-printable; `underscores` for header words, where "_" is a space. */
    static func quotedPrintable(_ data: Data, underscores: Bool = false) -> Data {
        let bytes = [UInt8](data)
        var out = Data(capacity: bytes.count)
        var i = 0
        while i < bytes.count {
            let byte = bytes[i]
            if byte == UInt8(ascii: "="), i + 1 < bytes.count {
                if bytes[i + 1] == UInt8(ascii: "\r") || bytes[i + 1] == UInt8(ascii: "\n") {
                    // A soft line break.
                    i += bytes[i + 1] == UInt8(ascii: "\r") && i + 2 < bytes.count && bytes[i + 2] == UInt8(ascii: "\n") ? 3 : 2
                    continue
                }
                if i + 2 < bytes.count, let value = UInt8(String(decoding: bytes[(i + 1)...(i + 2)], as: UTF8.self), radix: 16) {
                    out.append(value)
                    i += 3
                    continue
                }
            }
            out.append(underscores && byte == UInt8(ascii: "_") ? UInt8(ascii: " ") : byte)
            i += 1
        }
        return out
    }

    // ── Headers ──────────────────────────────────────────────────────────────

    /** "=?UTF-8?Q?Caf=C3=A9?=" → "Café"; the space between two encoded words goes. */
    static func words(_ header: String) -> String {
        guard header.contains("=?") else { return header }
        let pattern = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/
        var out = ""
        var rest = header[...]
        var afterWord = false
        while let match = rest.firstMatch(of: pattern) {
            let gap = rest[..<match.range.lowerBound]
            if !(afterWord && gap.allSatisfy(\.isWhitespace)) { out += gap }
            let charset = String(match.output.1).split(separator: "*").first.map(String.init)
            let bytes = match.output.2.lowercased() == "b"
                ? base64(String(match.output.3))
                : quotedPrintable(Data(match.output.3.utf8), underscores: true)
            out += text(bytes, charset: charset)
            rest = rest[match.range.upperBound...]
            afterWord = true
        }
        return out + rest
    }

    /** A header's value in a block of headers (unfolded, words decoded). */
    static func header(_ name: String, in block: String) -> String? {
        let unfolded = block.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n[ \t]+", with: " ", options: .regularExpression)
        let prefix = name.lowercased() + ":"
        return unfolded.split(separator: "\n")
            .first { $0.lowercased().hasPrefix(prefix) }
            .map { words($0.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)) }
    }

    /** A parameter's value, RFC 2231's `filename*=UTF-8''…` included. */
    static func parameter(_ name: String, in params: [String: String]) -> String? {
        if let extended = params[name + "*"] {
            let parts = extended.split(separator: "'", maxSplits: 2, omittingEmptySubsequences: false)
            let value = parts.count == 3 ? String(parts[2]) : extended
            return value.removingPercentEncoding ?? value
        }
        return params[name].map(words)
    }

    // ── Folder names ─────────────────────────────────────────────────────────

    /** IMAP's modified UTF-7 → text: "Entw&APw-rfe" → "Entwürfe". */
    static func folderName(_ encoded: String) -> String {
        var out = ""
        var rest = encoded[...]
        while let amp = rest.firstIndex(of: "&") {
            out += rest[..<amp]
            guard let dash = rest[amp...].firstIndex(of: "-") else { return out + rest[amp...] }
            let run = rest[rest.index(after: amp)..<dash]
            if run.isEmpty {
                out += "&"
            } else {
                let bytes = [UInt8](base64(run.replacingOccurrences(of: ",", with: "/")))
                let units = stride(from: 0, to: bytes.count - 1, by: 2).map { UInt16(bytes[$0]) << 8 | UInt16(bytes[$0 + 1]) }
                out += String(decoding: units, as: UTF16.self)
            }
            rest = rest[rest.index(after: dash)...]
        }
        return out + rest
    }

    /** Text → IMAP's modified UTF-7, for creating a folder. */
    static func encodedFolderName(_ name: String) -> String {
        var out = ""
        var pending: [UInt16] = []
        func flush() {
            guard !pending.isEmpty else { return }
            let bytes = pending.flatMap { [UInt8($0 >> 8), UInt8($0 & 0xff)] }
            let b64 = Data(bytes).base64EncodedString().replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "/", with: ",")
            out += "&\(b64)-"
            pending = []
        }
        for scalar in name.unicodeScalars {
            if (0x20...0x7e).contains(scalar.value) {
                flush()
                out += scalar == "&" ? "&-" : String(scalar)
            } else {
                pending += String(scalar).utf16
            }
        }
        flush()
        return out
    }
}
