//! The made-up mailbox's "server": the cache itself. Changes stick, sending
//! files the message under Sent, nothing leaves the machine.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;

use crate::model::*;
use crate::provider::*;
use crate::store::{Store, ViewRule};

pub struct DemoProvider {
    pub account: Account,
    pub store: Arc<Store>,
}

impl DemoProvider {
    fn message_from_draft(&self, draft: &Draft, id: &str, labels: Vec<String>) -> Message {
        Message {
            account_id: self.account.id.clone(),
            id: id.to_string(),
            thread_id: draft.thread_id.clone().unwrap_or_else(|| id.to_string()),
            date: chrono::Utc::now().timestamp_millis(),
            from: Person {
                name: self.account.name.clone(),
                email: self.account.email.clone(),
            },
            to: draft.to.clone(),
            cc: draft.cc.clone(),
            bcc: draft.bcc.clone(),
            reply_to: vec![],
            subject: draft.subject.clone(),
            snippet: crate::text::snippet(&draft.body_text, 200),
            label_ids: labels,
            unread: false,
            starred: false,
            draft: false,
            body_html: (!draft.body_html.is_empty()).then(|| draft.body_html.clone()),
            body_text: Some(draft.body_text.clone()),
            attachments: draft
                .attachments
                .iter()
                .enumerate()
                .map(|(i, a)| Attachment {
                    id: format!("{id}-att-{i}"),
                    filename: a.filename.clone(),
                    mime_type: a.mime_type.clone(),
                    size: a.data.len() as i64,
                    content_id: None,
                    inline: false,
                })
                .collect(),
            message_id_header: Some(format!("<{id}@otter.example>")),
            references: draft.references.clone(),
            in_reply_to: draft.in_reply_to.clone(),
            list_unsubscribe: None,
            list_unsubscribe_post: None,
        }
    }
}

#[async_trait]
impl Provider for DemoProvider {
    async fn sync(&self, _ctx: &SyncContext) -> Result<()> {
        Ok(())
    }

    async fn fetch_thread(&self, _thread_id: &str) -> Result<()> {
        Ok(())
    }

    async fn fetch_message(&self, _message_id: &str) -> Result<()> {
        Ok(())
    }

    async fn modify(
        &self,
        _thread_id: &str,
        _ids: &[String],
        _action: &ThreadAction,
    ) -> Result<()> {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        Ok(())
    }

    async fn send(&self, draft: &Draft) -> Result<()> {
        let id = format!("demo-sent-{}", uuid::Uuid::new_v4().simple());
        let message = self.message_from_draft(draft, &id, vec!["SENT".into()]);
        self.store.upsert_details(&[message])?;
        if let Some(draft_id) = &draft.draft_id {
            self.store
                .delete_messages(&self.account.id, &[draft_id.clone()])?;
        }
        self.store.recount_labels(&self.account.id)?;
        Ok(())
    }

    async fn save_draft(&self, draft: &Draft) -> Result<SavedDraft> {
        let id = draft
            .draft_id
            .clone()
            .unwrap_or_else(|| format!("demo-draft-{}", uuid::Uuid::new_v4().simple()));
        let message = self.message_from_draft(draft, &id, vec!["DRAFT".into()]);
        self.store.upsert_details(&[message])?;
        self.store.set_draft_id(&self.account.id, &id, &id)?;
        self.store.recount_labels(&self.account.id)?;
        Ok(SavedDraft {
            draft_id: id.clone(),
            message_id: Some(id.clone()),
            thread_id: Some(draft.thread_id.clone().unwrap_or(id)),
        })
    }

    async fn delete_draft(&self, draft_id: &str) -> Result<()> {
        self.store
            .delete_messages(&self.account.id, &[draft_id.to_string()])?;
        Ok(())
    }

    async fn attachment(&self, message_id: &str, attachment_id: &str) -> Result<Vec<u8>> {
        let message = self.store.message(&self.account.id, message_id)?;
        let attachment = message
            .and_then(|m| m.attachments.into_iter().find(|a| a.id == attachment_id))
            .ok_or_else(|| anyhow::anyhow!("no such attachment"))?;
        Ok(if attachment.mime_type == "image/svg+xml" {
            br##"<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#0ea5e9"/><text x="120" y="88" font-size="28" text-anchor="middle" fill="white">Otter</text></svg>"##.to_vec()
        } else {
            format!("{} (made up for the demo)\n", attachment.filename).into_bytes()
        })
    }

    async fn search(&self, query: &str, page: Option<String>) -> Result<SearchPage> {
        let offset: usize = page.and_then(|p| p.parse().ok()).unwrap_or(0);
        let q = crate::search::parse_query(query, &self.account.id);
        let (rows, more) = self.store.search_threads(&q, offset, 50)?;
        Ok(SearchPage {
            refs: rows
                .iter()
                .map(|r| (r.account_id.clone(), r.id.clone()))
                .collect(),
            next: more.then(|| (offset + rows.len()).to_string()),
            estimate: None,
        })
    }

    async fn create_label(&self, name: &str) -> Result<Label> {
        let label = Label {
            account_id: self.account.id.clone(),
            id: format!("Label_{}", uuid::Uuid::new_v4().simple()),
            name: name.to_string(),
            system: false,
            background_color: None,
            text_color: None,
            unread: 0,
            total: 0,
        };
        Ok(label)
    }

    async fn update_label(
        &self,
        _id: &str,
        _name: Option<&str>,
        _color: Option<(String, String)>,
    ) -> Result<()> {
        Ok(())
    }

    async fn delete_label(&self, _id: &str) -> Result<()> {
        Ok(())
    }

    async fn empty_folder(&self, label_id: &str) -> Result<usize> {
        let rule = ViewRule {
            account_id: self.account.id.clone(),
            all_of: vec![label_id.to_string()],
            none_of: vec![],
        };
        let (rows, _) = self.store.threads_page(&[rule], 0, 10_000)?;
        let mut ids = Vec::new();
        for row in rows {
            ids.extend(self.store.thread_message_ids(&self.account.id, &row.id)?);
        }
        self.store.delete_messages(&self.account.id, &ids)?;
        Ok(ids.len())
    }
}
