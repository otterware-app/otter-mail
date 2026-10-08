//! The made-up mailboxes (packages/shared's demo-mailboxes, exported as JSON
//! for the iPhone app): two accounts, a few weeks of mail. `--demo` runs on
//! them, with no Google account and no network.

use serde::Deserialize;

use crate::model::*;

const DEMO_JSON: &str = include_str!("../../../apps/ios/OtterMail/Resources/DemoMailboxes.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoAccount {
    email: String,
    name: String,
    display_name: Option<String>,
    color: Option<String>,
    picture: Option<String>,
    signature: Option<String>,
    labels: Vec<DemoLabel>,
    threads: Vec<DemoThread>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoLabel {
    name: String,
    color: Option<DemoColor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoColor {
    background_color: String,
    text_color: String,
}

#[derive(Deserialize)]
struct DemoThread {
    subject: String,
    labels: Vec<String>,
    messages: Vec<DemoMessage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoMessage {
    from: Option<DemoPerson>,
    #[serde(default)]
    to: Vec<DemoPerson>,
    hours_ago: f64,
    text: Option<String>,
    html: Option<String>,
    #[serde(default)]
    unread: bool,
    #[serde(default)]
    starred: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    attachments: Vec<DemoAttachment>,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
}

#[derive(Deserialize, Clone)]
struct DemoPerson {
    name: Option<String>,
    email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoAttachment {
    filename: String,
    mime_type: String,
    size: i64,
}

pub struct DemoMailbox {
    pub account: Account,
    pub labels: Vec<Label>,
    pub messages: Vec<Message>,
}

fn label_id(name: &str) -> String {
    if SystemFolder::from_label_id(name).is_some()
        || name.starts_with("CATEGORY_")
        || ["UNREAD", "STARRED", "IMPORTANT"].contains(&name)
    {
        name.to_string()
    } else {
        format!("Label_{}", name.replace('/', "_").replace(' ', "_"))
    }
}

/// The demo mailboxes, their times relative to `now_ms`.
pub fn mailboxes(now_ms: i64) -> Vec<DemoMailbox> {
    let accounts: Vec<DemoAccount> = serde_json::from_str(DEMO_JSON).expect("DemoMailboxes.json");
    accounts
        .into_iter()
        .enumerate()
        .map(|(position, demo)| {
            let account_id = demo.email.to_lowercase();
            let me = Person {
                name: Some(demo.name.clone()),
                email: demo.email.clone(),
            };
            let account = Account {
                id: account_id.clone(),
                email: demo.email.clone(),
                name: Some(demo.name.clone()),
                display_name: demo.display_name.clone(),
                color: demo.color.clone(),
                picture: demo.picture.clone(),
                provider: ProviderKind::Demo,
                enabled: true,
                position: position as i64,
                signature: demo.signature.clone(),
                signed_out: false,
            };
            let mut labels: Vec<Label> = SystemFolder::ALL
                .iter()
                .filter(|f| **f != SystemFolder::All)
                .map(|f| Label {
                    account_id: account_id.clone(),
                    id: f.label_id().into(),
                    name: f.label_id().into(),
                    system: true,
                    background_color: None,
                    text_color: None,
                    unread: 0,
                    total: 0,
                })
                .collect();
            labels.extend(demo.labels.iter().map(|l| Label {
                account_id: account_id.clone(),
                id: label_id(&l.name),
                name: l.name.clone(),
                system: false,
                background_color: l.color.as_ref().map(|c| c.background_color.clone()),
                text_color: l.color.as_ref().map(|c| c.text_color.clone()),
                unread: 0,
                total: 0,
            }));
            let mut messages = Vec::new();
            for (t, thread) in demo.threads.iter().enumerate() {
                let thread_id = format!("demo-{position}-{t:03}");
                let mut previous_id: Option<String> = None;
                for (m, msg) in thread.messages.iter().enumerate() {
                    let id = format!("{thread_id}-{m}");
                    let from = msg
                        .from
                        .clone()
                        .map(|p| Person {
                            name: p.name,
                            email: p.email,
                        })
                        .unwrap_or_else(|| me.clone());
                    let to = if msg.to.is_empty() {
                        vec![me.clone()]
                    } else {
                        msg.to
                            .iter()
                            .map(|p| Person {
                                name: p.name.clone(),
                                email: p.email.clone(),
                            })
                            .collect()
                    };
                    let mut label_ids: Vec<String> =
                        thread.labels.iter().map(|l| label_id(l)).collect();
                    if from.email.eq_ignore_ascii_case(&demo.email) && !msg.draft {
                        label_ids.push("SENT".into());
                    }
                    if msg.unread {
                        label_ids.push("UNREAD".into());
                    }
                    if msg.starred {
                        label_ids.push("STARRED".into());
                    }
                    if msg.draft {
                        label_ids.retain(|l| l != "INBOX");
                        label_ids.push("DRAFT".into());
                    }
                    let text = msg.text.clone();
                    let snippet = text
                        .as_deref()
                        .or(msg.html.as_deref())
                        .map(|t| crate::text::snippet(t, 200))
                        .unwrap_or_default();
                    let subject = if m == 0 || thread.subject.starts_with("Re:") {
                        thread.subject.clone()
                    } else {
                        format!("Re: {}", thread.subject)
                    };
                    let message_id_header = format!("<{id}@otter.example>");
                    messages.push(Message {
                        account_id: account_id.clone(),
                        id: id.clone(),
                        thread_id: thread_id.clone(),
                        date: now_ms - (msg.hours_ago * 3_600_000.) as i64,
                        from,
                        to,
                        cc: vec![],
                        bcc: vec![],
                        reply_to: vec![],
                        subject,
                        snippet,
                        label_ids,
                        unread: msg.unread,
                        starred: msg.starred,
                        draft: msg.draft,
                        body_html: msg.html.clone(),
                        body_text: text,
                        attachments: msg
                            .attachments
                            .iter()
                            .enumerate()
                            .map(|(i, a)| Attachment {
                                id: format!("{id}-att-{i}"),
                                filename: a.filename.clone(),
                                mime_type: a.mime_type.clone(),
                                size: a.size,
                                content_id: None,
                                inline: false,
                            })
                            .collect(),
                        message_id_header: Some(message_id_header.clone()),
                        references: previous_id.clone(),
                        in_reply_to: previous_id.clone(),
                        list_unsubscribe: msg.headers.get("List-Unsubscribe").cloned(),
                        list_unsubscribe_post: msg.headers.get("List-Unsubscribe-Post").cloned(),
                    });
                    previous_id = Some(message_id_header);
                }
            }
            DemoMailbox {
                account,
                labels,
                messages,
            }
        })
        .collect()
}
