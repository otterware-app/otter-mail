import Foundation

/**
 * A message's MIME source (RFC 2045/2046), as Outlook hands it over
 * (`/messages/{id}/$value`): its headers, its plain and HTML bodies, and its
 * files, inline images among them, as core reads it with postal-mime. Parts
 * are walked as bytes: a body's line breaks and charsets are its own.
 */
nonisolated enum MIMEParser {
    struct File {
        var filename: String
        var mimeType: String
        var data: Data
        /** Set on an image the HTML shows inline (`cid:` + this). */
        var contentID: String?
        var inline: Bool
    }

    struct Parsed {
        /** The message's own header block. */
        var headers: String
        var text: String?
        var html: String?
        var files: [File] = []
    }

    static func parse(_ data: Data) -> Parsed {
        let bytes = [UInt8](data)
        var parsed = Parsed(headers: headerText(split(bytes[...]).headers))
        walk(bytes[...], into: &parsed, depth: 0)
        return parsed
    }

    // ── Parts ────────────────────────────────────────────────────────────────

    private static func walk(_ part: ArraySlice<UInt8>, into parsed: inout Parsed, depth: Int) {
        let (head, body) = split(part)
        let headers = headerText(head)
        let field = { (name: String) in MailDecoding.header(name, in: headers) }
        let (type, params) = value(field("Content-Type") ?? "text/plain")
        if type.hasPrefix("multipart/"), let boundary = params["boundary"], depth < 20 {
            for child in parts(body, boundary: boundary) { walk(child, into: &parsed, depth: depth + 1) }
            return
        }
        let (disposition, dispositionParams) = value(field("Content-Disposition") ?? "")
        let filename = MailDecoding.parameter("filename", in: dispositionParams) ?? MailDecoding.parameter("name", in: params)
        let data = MailDecoding.transfer(Data(body), encoding: field("Content-Transfer-Encoding") ?? "7bit")
        if (type == "text/plain" || type == "text/html"), disposition != "attachment", filename == nil {
            let text = MailDecoding.text(data, charset: params["charset"]).replacingOccurrences(of: "\r\n", with: "\n")
            // The first of each is the message's (later ones are forwarded or attached).
            if type == "text/html" { parsed.html = parsed.html ?? text } else { parsed.text = parsed.text ?? text }
            return
        }
        let contentID = field("Content-ID")?.trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
        let inline = contentID != nil && disposition != "attachment" && type.hasPrefix("image/")
        // A nameless part that's no attachment (an invitation's text/calendar alternative) isn't a file to show.
        guard filename != nil || inline || disposition == "attachment" || type == "message/rfc822" else { return }
        let name = filename ?? (type == "message/rfc822" ? "message.eml" : "")
        parsed.files.append(File(filename: name, mimeType: type, data: data, contentID: contentID, inline: inline))
    }

    /** A part's header block and body: they part at the first empty line. */
    static func split(_ part: ArraySlice<UInt8>) -> (headers: ArraySlice<UInt8>, body: ArraySlice<UInt8>) {
        let start = part.startIndex
        if part.starts(with: [13, 10]) { return (part[start..<start], part.dropFirst(2)) }
        if part.starts(with: [10]) { return (part[start..<start], part.dropFirst()) }
        let crlf = find([13, 10, 13, 10], in: part, from: start)
        let lf = find([10, 10], in: part, from: start)
        switch (crlf, lf) {
        case let (crlf?, lf?) where lf < crlf: return (part[..<lf], part[(lf + 2)...])
        case let (crlf?, _): return (part[..<crlf], part[(crlf + 4)...])
        case let (nil, lf?): return (part[..<lf], part[(lf + 2)...])
        default: return (part, part[part.endIndex...])
        }
    }

    /** A multipart body's parts, between its `--boundary` lines. */
    static func parts(_ body: ArraySlice<UInt8>, boundary: String) -> [ArraySlice<UInt8>] {
        let delimiter = Array("--\(boundary)".utf8)
        var parts: [ArraySlice<UInt8>] = []
        // The first delimiter starts the body or a line.
        var at: Int? = body.starts(with: delimiter) ? body.startIndex : find([10] + delimiter, in: body, from: body.startIndex).map { $0 + 1 }
        while let found = at {
            let after = found + delimiter.count
            // "--boundary--" closes it.
            if body[after...].starts(with: [45, 45]) { break }
            guard let lineEnd = find([10], in: body, from: after) else { break }
            let start = lineEnd + 1
            let next = find([10] + delimiter, in: body, from: start)
            var end = next ?? body.endIndex
            if end > start, body[end - 1] == 13 { end -= 1 }
            parts.append(body[start..<max(start, end)])
            at = next.map { $0 + 1 }
        }
        return parts
    }

    private static func find(_ needle: [UInt8], in hay: ArraySlice<UInt8>, from: Int) -> Int? {
        guard let first = needle.first, hay.endIndex - from >= needle.count else { return nil }
        var i = from
        while i <= hay.endIndex - needle.count {
            guard let hit = hay[i...(hay.endIndex - needle.count)].firstIndex(of: first) else { return nil }
            if hay[hit..<(hit + needle.count)].elementsEqual(needle) { return hit }
            i = hit + 1
        }
        return nil
    }

    // ── Headers ──────────────────────────────────────────────────────────────

    /** Headers as text: UTF-8 when they are (RFC 6532), else byte for byte. */
    private static func headerText(_ bytes: ArraySlice<UInt8>) -> String {
        String(validating: bytes, as: UTF8.self) ?? String(data: Data(bytes), encoding: .isoLatin1) ?? ""
    }

    /** "text/plain; charset=\"utf-8\"" → its value (lowercased) and parameters (keys lowercased, quotes gone). */
    static func value(_ header: String) -> (String, [String: String]) {
        var fields: [String] = []
        var current = ""
        var quoted = false
        for character in header {
            if character == "\"" { quoted.toggle() }
            if character == ";", !quoted {
                fields.append(current)
                current = ""
            } else {
                current.append(character)
            }
        }
        fields.append(current)
        let value = fields.removeFirst().trimmingCharacters(in: .whitespaces).lowercased()
        var params: [String: String] = [:]
        for field in fields {
            guard let equals = field.firstIndex(of: "=") else { continue }
            let key = field[..<equals].trimmingCharacters(in: .whitespaces).lowercased()
            var raw = field[field.index(after: equals)...].trimmingCharacters(in: .whitespaces)
            if raw.count >= 2, raw.hasPrefix("\""), raw.hasSuffix("\"") { raw = String(raw.dropFirst().dropLast()) }
            params[key] = raw
        }
        return (value, params)
    }
}
