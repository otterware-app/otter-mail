//! Outgoing mail as MIME: a text part always, HTML beside it when there is
//! some, attachments around them; replies carry In-Reply-To and References.

use anyhow::Result;
use mail_builder::MessageBuilder;
use mail_builder::headers::address::Address;

use crate::model::{Draft, Person};

/// Attachments may add up to 25 MiB.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

fn ids(header: &str) -> Vec<String> {
    header
        .split_whitespace()
        .map(|id| id.trim_matches(|c| c == '<' || c == '>').to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

fn addresses(people: &[Person]) -> Address<'static> {
    Address::new_list(
        people
            .iter()
            .map(
                |p| match p.name.as_deref().filter(|n| !n.is_empty() && *n != p.email) {
                    Some(name) => Address::new_address(Some(name.to_string()), p.email.clone()),
                    None => Address::new_address(None::<String>, p.email.clone()),
                },
            )
            .collect(),
    )
}

/// The message as bytes. `with_date` adds Date and Message-ID (Gmail adds
/// its own; SMTP needs them).
pub fn build(from: &Person, draft: &Draft, with_bcc: bool) -> Result<Vec<u8>> {
    let mut builder = MessageBuilder::new().from(addresses(std::slice::from_ref(from)));
    if !draft.to.is_empty() {
        builder = builder.to(addresses(&draft.to));
    }
    if !draft.cc.is_empty() {
        builder = builder.cc(addresses(&draft.cc));
    }
    if with_bcc && !draft.bcc.is_empty() {
        builder = builder.bcc(addresses(&draft.bcc));
    }
    builder = builder.subject(draft.subject.clone());
    if let Some(in_reply_to) = &draft.in_reply_to {
        builder = builder.in_reply_to(ids(in_reply_to));
    }
    if let Some(references) = &draft.references {
        builder = builder.references(ids(references));
    }
    builder = builder.text_body(draft.body_text.clone());
    if !draft.body_html.trim().is_empty() {
        builder = builder.html_body(draft.body_html.clone());
    }
    let total: usize = draft.attachments.iter().map(|a| a.data.len()).sum();
    if total > MAX_ATTACHMENT_BYTES {
        anyhow::bail!("Attachments can add up to 25 MB");
    }
    for a in &draft.attachments {
        builder = builder.attachment(a.mime_type.clone(), a.filename.clone(), a.data.clone());
    }
    Ok(builder.write_to_vec()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_headers_and_parts() {
        let draft = Draft {
            account_id: "me@x.com".into(),
            to: vec![Person {
                name: Some("Zoë Björklund".into()),
                email: "zoe@x.com".into(),
            }],
            subject: "Re: Hello".into(),
            body_text: "Hi".into(),
            body_html: "<p>Hi</p>".into(),
            in_reply_to: Some("<a@x>".into()),
            references: Some("<z@x> <a@x>".into()),
            ..Default::default()
        };
        let me = Person {
            name: Some("Me".into()),
            email: "me@x.com".into(),
        };
        let raw = String::from_utf8(build(&me, &draft, true).unwrap()).unwrap();
        assert!(raw.contains("In-Reply-To: <a@x>"));
        assert!(raw.contains("References: <z@x>"));
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("zoe@x.com"));
    }
}
