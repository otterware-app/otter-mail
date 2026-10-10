//! Gmail API message resources → the app's messages.

use serde_json::Value;

use super::api::decode_base64url;
use crate::model::*;
use crate::text;

fn header<'a>(payload: &'a Value, name: &str) -> Option<&'a str> {
    payload["headers"]
        .as_array()?
        .iter()
        .find(|h| {
            h["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .and_then(|h| h["value"].as_str())
}

fn charset(part: &Value) -> Option<String> {
    let content_type = header(part, "Content-Type")?;
    content_type.split(';').find_map(|p| {
        let (k, v) = p.trim().split_once('=')?;
        k.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| v.trim().trim_matches('"').to_string())
    })
}

fn decode_text(part: &Value, data: &str) -> Option<String> {
    let bytes = decode_base64url(data).ok()?;
    if let Some(label) = charset(part) {
        if let Some(encoding) = encoding_rs::Encoding::for_label(label.as_bytes()) {
            if encoding != encoding_rs::UTF_8 {
                return Some(encoding.decode(&bytes).0.into_owned());
            }
        }
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// What a list or metadata fetch knows: headers, labels, snippet.
pub fn summary(account_id: &str, v: &Value) -> Option<Message> {
    let id = v["id"].as_str()?.to_string();
    let payload = &v["payload"];
    let from = header(payload, "From")
        .map(text::parse_address)
        .unwrap_or_default();
    let label_ids: Vec<String> = v["labelIds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| l.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Some(Message {
        account_id: account_id.to_string(),
        thread_id: v["threadId"].as_str().unwrap_or(&id).to_string(),
        date: v["internalDate"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .or_else(|| v["internalDate"].as_i64())
            .unwrap_or(0),
        from,
        to: header(payload, "To")
            .map(text::parse_address_list)
            .unwrap_or_default(),
        cc: header(payload, "Cc")
            .map(text::parse_address_list)
            .unwrap_or_default(),
        bcc: header(payload, "Bcc")
            .map(text::parse_address_list)
            .unwrap_or_default(),
        reply_to: header(payload, "Reply-To")
            .map(text::parse_address_list)
            .unwrap_or_default(),
        subject: header(payload, "Subject").unwrap_or_default().to_string(),
        snippet: text::decode_entities(v["snippet"].as_str().unwrap_or_default()),
        unread: label_ids.iter().any(|l| l == "UNREAD"),
        starred: label_ids.iter().any(|l| l == "STARRED"),
        draft: label_ids.iter().any(|l| l == "DRAFT"),
        label_ids,
        body_html: None,
        body_text: None,
        attachments: vec![],
        message_id_header: header(payload, "Message-ID")
            .or_else(|| header(payload, "Message-Id"))
            .map(String::from),
        references: header(payload, "References").map(String::from),
        in_reply_to: header(payload, "In-Reply-To").map(String::from),
        list_unsubscribe: header(payload, "List-Unsubscribe").map(String::from),
        list_unsubscribe_post: header(payload, "List-Unsubscribe-Post").map(String::from),
        id,
    })
}

/// A `format=full` message: the summary plus bodies and attachments.
pub fn detail(account_id: &str, v: &Value) -> Option<Message> {
    let mut message = summary(account_id, v)?;
    let payload = &v["payload"];
    let mut html: Option<String> = None;
    let mut plain: Option<String> = None;
    let mut attachments = Vec::new();
    walk(payload, &mut html, &mut plain, &mut attachments);
    message.body_text = Some(plain.unwrap_or_default());
    message.body_html = html;
    message.attachments = attachments;
    Some(message)
}

fn walk(
    part: &Value,
    html: &mut Option<String>,
    plain: &mut Option<String>,
    attachments: &mut Vec<Attachment>,
) {
    let mime = part["mimeType"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let filename = part["filename"].as_str().unwrap_or_default();
    let body = &part["body"];
    if let Some(attachment_id) = body["attachmentId"].as_str() {
        if !filename.is_empty() || !mime.starts_with("text/") {
            let content_id = header(part, "Content-ID")
                .or_else(|| header(part, "Content-Id"))
                .map(|c| {
                    c.trim()
                        .trim_matches(|ch| ch == '<' || ch == '>')
                        .to_string()
                });
            let disposition = header(part, "Content-Disposition")
                .unwrap_or_default()
                .to_ascii_lowercase();
            attachments.push(Attachment {
                id: attachment_id.to_string(),
                filename: if filename.is_empty() {
                    "attachment".into()
                } else {
                    filename.to_string()
                },
                mime_type: mime.clone(),
                size: body["size"].as_i64().unwrap_or(0),
                inline: content_id.is_some() && !disposition.starts_with("attachment"),
                content_id,
            });
            return;
        }
    }
    if let Some(data) = body["data"].as_str() {
        if filename.is_empty()
            || mime.starts_with("text/")
                && !header(part, "Content-Disposition")
                    .unwrap_or_default()
                    .starts_with("attachment")
        {
            if mime == "text/html" && html.is_none() {
                *html = decode_text(part, data);
            } else if mime == "text/plain" && plain.is_none() {
                *plain = decode_text(part, data);
            }
        }
    }
    if let Some(parts) = part["parts"].as_array() {
        for p in parts {
            walk(p, html, plain, attachments);
        }
    }
}

/// A label resource → the app's label.
pub fn label(account_id: &str, v: &Value) -> Option<Label> {
    Some(Label {
        account_id: account_id.to_string(),
        id: v["id"].as_str()?.to_string(),
        name: v["name"].as_str()?.to_string(),
        system: v["type"].as_str() == Some("system"),
        background_color: v["color"]["backgroundColor"].as_str().map(String::from),
        text_color: v["color"]["textColor"].as_str().map(String::from),
        unread: v["messagesUnread"].as_i64().unwrap_or(0),
        total: v["messagesTotal"].as_i64().unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn walks_parts() {
        let html = super::super::api::base64url(b"<p>Hi</p>");
        let plain = super::super::api::base64url(b"Hi");
        let v = json!({
            "id": "m1", "threadId": "t1", "labelIds": ["INBOX", "UNREAD"], "snippet": "Hi &amp; bye",
            "internalDate": "1700000000000",
            "payload": {
                "mimeType": "multipart/mixed",
                "headers": [{"name": "From", "value": "Ada <ada@x.com>"}, {"name": "Subject", "value": "Hello"}],
                "parts": [
                    {"mimeType": "multipart/alternative", "parts": [
                        {"mimeType": "text/plain", "body": {"data": plain}},
                        {"mimeType": "text/html", "body": {"data": html}}
                    ]},
                    {"mimeType": "application/pdf", "filename": "a.pdf", "body": {"attachmentId": "att1", "size": 10}}
                ]
            }
        });
        let m = detail("me", &v).unwrap();
        assert_eq!(m.from.name.as_deref(), Some("Ada"));
        assert!(m.unread);
        assert_eq!(m.snippet, "Hi & bye");
        assert_eq!(m.body_html.as_deref(), Some("<p>Hi</p>"));
        assert_eq!(m.body_text.as_deref(), Some("Hi"));
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(m.date, 1_700_000_000_000);
    }
}
