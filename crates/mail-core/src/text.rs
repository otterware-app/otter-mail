//! Small text helpers: snippets, address lists, subjects.

use crate::model::Person;

/// Whitespace collapsed, cut to `max` characters (HTML tags dropped).
pub fn snippet(text: &str, max: usize) -> String {
    let plain = if text.contains('<') && text.contains('>') {
        strip_tags(text)
    } else {
        text.to_string()
    };
    let collapsed = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max).collect()
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(&out)
}

pub fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

/// Splits on commas outside double quotes and angle brackets.
pub fn split_addresses(field: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut angle = false;
    for c in field.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            '<' if !quoted => {
                angle = true;
                current.push(c);
            }
            '>' if !quoted => {
                angle = false;
                current.push(c);
            }
            ',' | ';' if !quoted && !angle => {
                if !current.trim().is_empty() {
                    parts.push(current.trim().to_string());
                }
                current.clear();
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }
    parts
}

/// `Name <email>` or a bare address.
pub fn parse_address(raw: &str) -> Person {
    let raw = raw.trim();
    if let (Some(start), Some(end)) = (raw.rfind('<'), raw.rfind('>')) {
        if start < end {
            let email = raw[start + 1..end].trim().to_string();
            let name = raw[..start].trim().trim_matches('"').trim().to_string();
            return Person {
                name: (!name.is_empty() && name != email).then_some(name),
                email,
            };
        }
    }
    Person {
        name: None,
        email: raw.trim_matches('"').to_string(),
    }
}

pub fn parse_address_list(field: &str) -> Vec<Person> {
    split_addresses(field)
        .iter()
        .map(|part| parse_address(part))
        .filter(|p| !p.email.is_empty())
        .collect()
}

pub fn format_address_list(people: &[Person]) -> String {
    people
        .iter()
        .map(Person::to_header)
        .collect::<Vec<_>>()
        .join(", ")
}

/// "Re: Re: Fwd: x" → "x", for grouping and display.
pub fn base_subject(subject: &str) -> &str {
    let mut s = subject.trim();
    loop {
        let lower = s.to_ascii_lowercase();
        let cut = ["re:", "fwd:", "fw:", "aw:", "wg:", "sv:"]
            .iter()
            .find(|p| lower.starts_with(*p))
            .map(|p| p.len());
        match cut {
            Some(n) => s = s[n..].trim_start(),
            None => return s,
        }
    }
}

/// "Re: x" without stacking prefixes.
pub fn prefix_subject(prefix: &str, subject: &str) -> String {
    let lower = subject.trim().to_ascii_lowercase();
    let p = prefix.to_ascii_lowercase();
    let already = match p.as_str() {
        "re:" => lower.starts_with("re:"),
        _ => lower.starts_with("fwd:") || lower.starts_with("fw:"),
    };
    if already {
        subject.trim().to_string()
    } else {
        format!("{prefix} {}", subject.trim())
    }
}

/// Plain text from HTML, for replies, forwards and snippets.
pub fn html_to_text(html: &str) -> String {
    html2text::from_read(html.as_bytes(), 100).unwrap_or_else(|_| strip_tags(html))
}
