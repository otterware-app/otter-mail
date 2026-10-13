//! Gmail's REST API (`gmail/v1/users/me`): every call the provider makes, with
//! the Electron app's retry rules: a 401 refreshes the token once, rate limits
//! back off (honoring Retry-After), network errors and 5xx retry a few times.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use base64::Engine as _;
use serde_json::{Value, json};

use crate::google::GoogleAuth;

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const RATE_LIMIT_DELAYS: [u64; 6] = [1, 2, 4, 8, 15, 30];

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = serde_json::from_str::<Value>(&self.body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| self.body.chars().take(200).collect());
        write!(f, "Gmail API error: {} — {reason}", self.status)
    }
}

impl std::error::Error for ApiError {}

pub fn status_of(err: &anyhow::Error) -> Option<u16> {
    err.downcast_ref::<ApiError>().map(|e| e.status)
}

pub fn is_offline(err: &anyhow::Error) -> bool {
    err.downcast_ref::<reqwest::Error>()
        .is_some_and(|e| e.is_connect() || e.is_timeout() || e.is_request())
}

#[derive(Clone)]
pub struct GmailApi {
    pub email: String,
    google: Arc<GoogleAuth>,
    http: reqwest::Client,
    /// At most a few requests in flight per mailbox.
    permits: Arc<tokio::sync::Semaphore>,
}

impl GmailApi {
    pub fn new(email: String, google: Arc<GoogleAuth>) -> Self {
        GmailApi {
            email,
            google,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(90))
                .build()
                .expect("http client"),
            permits: Arc::new(tokio::sync::Semaphore::new(8)),
        }
    }

    pub async fn token(&self) -> Result<String> {
        self.google.access_token(&self.email, false).await
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value> {
        let url = if path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{BASE}{path}")
        };
        let _permit = self.permits.acquire().await?;
        let mut refreshed = false;
        let mut rate_limited = 0usize;
        let mut transient = 0u32;
        loop {
            let token = self.google.access_token(&self.email, false).await?;
            let mut req = self
                .http
                .request(method.clone(), &url)
                .bearer_auth(&token)
                .query(query);
            if let Some(body) = &body {
                req = req.json(body);
            }
            let response = match req.send().await {
                Ok(r) => r,
                Err(err) if transient < 3 && (err.is_connect() || err.is_timeout()) => {
                    transient += 1;
                    tokio::time::sleep(Duration::from_millis(2000 * 2u64.pow(transient - 1))).await;
                    continue;
                }
                Err(err) => return Err(err.into()),
            };
            let status = response.status().as_u16();
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            let text = response.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                if text.trim().is_empty() {
                    return Ok(json!({}));
                }
                return Ok(serde_json::from_str(&text)?);
            }
            if status == 401 && !refreshed {
                refreshed = true;
                self.google.access_token(&self.email, true).await?;
                continue;
            }
            let limited = status == 429
                || (status == 403
                    && [
                        "rateLimitExceeded",
                        "userRateLimitExceeded",
                        "RATE_LIMIT_EXCEEDED",
                        "Quota exceeded",
                    ]
                    .iter()
                    .any(|s| text.contains(s)));
            if limited && rate_limited < RATE_LIMIT_DELAYS.len() {
                let wait = retry_after.unwrap_or(RATE_LIMIT_DELAYS[rate_limited]);
                rate_limited += 1;
                log::info!("gmail rate limited ({}), waiting {wait}s", self.email);
                tokio::time::sleep(Duration::from_secs(wait)).await;
                continue;
            }
            if status >= 500 && transient < 3 {
                transient += 1;
                tokio::time::sleep(Duration::from_millis(1000 * 2u64.pow(transient - 1))).await;
                continue;
            }
            return Err(ApiError { status, body: text }.into());
        }
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        self.request(reqwest::Method::GET, path, query, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.request(reqwest::Method::POST, path, &[], Some(body))
            .await
    }

    pub async fn profile(&self) -> Result<Value> {
        self.get("/profile", &[]).await
    }

    pub async fn labels(&self) -> Result<Vec<Value>> {
        let v = self.get("/labels", &[]).await?;
        Ok(v["labels"].as_array().cloned().unwrap_or_default())
    }

    pub async fn label(&self, id: &str) -> Result<Value> {
        self.get(&format!("/labels/{}", enc(id)), &[]).await
    }

    pub async fn create_label(&self, name: &str) -> Result<Value> {
        self.post(
            "/labels",
            json!({"name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show"}),
        )
        .await
    }

    pub async fn patch_label(&self, id: &str, body: Value) -> Result<Value> {
        self.request(
            reqwest::Method::PATCH,
            &format!("/labels/{}", enc(id)),
            &[],
            Some(body),
        )
        .await
    }

    pub async fn delete_label(&self, id: &str) -> Result<()> {
        self.request(
            reqwest::Method::DELETE,
            &format!("/labels/{}", enc(id)),
            &[],
            None,
        )
        .await?;
        Ok(())
    }

    /// One page of message ids (newest first).
    pub async fn list_ids(
        &self,
        label: Option<&str>,
        q: Option<&str>,
        page_token: Option<&str>,
        max: u32,
        spam_trash: bool,
    ) -> Result<(Vec<(String, String)>, Option<String>, Option<i64>)> {
        let mut query = vec![("maxResults", max.to_string())];
        if spam_trash {
            query.push(("includeSpamTrash", "true".into()));
        }
        if let Some(label) = label {
            query.push(("labelIds", label.to_string()));
        }
        if let Some(q) = q {
            query.push(("q", q.to_string()));
        }
        if let Some(token) = page_token {
            query.push(("pageToken", token.to_string()));
        }
        let v = self.get("/messages", &query).await?;
        let refs = v["messages"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| {
                        Some((
                            m["id"].as_str()?.to_string(),
                            m["threadId"].as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok((
            refs,
            v["nextPageToken"].as_str().map(String::from),
            v["resultSizeEstimate"].as_i64(),
        ))
    }

    pub async fn message_metadata(&self, id: &str) -> Result<Value> {
        let mut query: Vec<(&str, String)> = vec![("format", "metadata".into())];
        for h in [
            "From",
            "To",
            "Cc",
            "Subject",
            "Date",
            "Message-ID",
            "References",
            "In-Reply-To",
        ] {
            query.push(("metadataHeaders", h.into()));
        }
        self.get(&format!("/messages/{id}"), &query).await
    }

    pub async fn message_full(&self, id: &str) -> Result<Value> {
        self.get(&format!("/messages/{id}"), &[("format", "full".into())])
            .await
    }

    pub async fn thread_full(&self, id: &str) -> Result<Value> {
        self.get(&format!("/threads/{id}"), &[("format", "full".into())])
            .await
    }

    pub async fn headers(&self, id: &str, names: &[&str]) -> Result<Value> {
        let mut query: Vec<(&str, String)> = vec![("format", "metadata".into())];
        for h in names {
            query.push(("metadataHeaders", h.to_string()));
        }
        self.get(&format!("/messages/{id}"), &query).await
    }

    /// The history feed since `start` (all pages). Err with status 404: expired.
    pub async fn history(&self, start: &str) -> Result<(Vec<Value>, Option<String>)> {
        let mut records = Vec::new();
        let mut page: Option<String> = None;
        let mut latest = None;
        loop {
            let mut query = vec![
                ("startHistoryId", start.to_string()),
                ("maxResults", "500".into()),
            ];
            if let Some(p) = &page {
                query.push(("pageToken", p.clone()));
            }
            let v = self.get("/history", &query).await?;
            if let Some(h) = v["history"].as_array() {
                records.extend(h.iter().cloned());
            }
            if let Some(id) = v["historyId"].as_str() {
                latest = Some(id.to_string());
            }
            match v["nextPageToken"].as_str() {
                Some(p) => page = Some(p.to_string()),
                None => break,
            }
        }
        Ok((records, latest))
    }

    pub async fn modify_thread(&self, id: &str, add: &[String], remove: &[String]) -> Result<()> {
        self.post(
            &format!("/threads/{id}/modify"),
            json!({"addLabelIds": add, "removeLabelIds": remove}),
        )
        .await?;
        Ok(())
    }

    pub async fn modify_message(&self, id: &str, add: &[String], remove: &[String]) -> Result<()> {
        self.post(
            &format!("/messages/{id}/modify"),
            json!({"addLabelIds": add, "removeLabelIds": remove}),
        )
        .await?;
        Ok(())
    }

    pub async fn trash_thread(&self, id: &str) -> Result<()> {
        self.post(&format!("/threads/{id}/trash"), json!({}))
            .await?;
        Ok(())
    }

    pub async fn untrash_thread(&self, id: &str) -> Result<()> {
        self.post(&format!("/threads/{id}/untrash"), json!({}))
            .await?;
        Ok(())
    }

    pub async fn trash_message(&self, id: &str) -> Result<()> {
        self.post(&format!("/messages/{id}/trash"), json!({}))
            .await?;
        Ok(())
    }

    pub async fn untrash_message(&self, id: &str) -> Result<()> {
        self.post(&format!("/messages/{id}/untrash"), json!({}))
            .await?;
        Ok(())
    }

    pub async fn batch_delete(&self, ids: &[String]) -> Result<()> {
        for chunk in ids.chunks(1000) {
            self.post("/messages/batchDelete", json!({"ids": chunk}))
                .await?;
        }
        Ok(())
    }

    pub async fn send_raw(&self, raw: &[u8], thread_id: Option<&str>) -> Result<Value> {
        let mut body = json!({"raw": base64url(raw)});
        if let Some(t) = thread_id {
            body["threadId"] = json!(t);
        }
        self.post("/messages/send", body).await
    }

    pub async fn save_draft(
        &self,
        draft_id: Option<&str>,
        raw: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Value> {
        let mut message = json!({"raw": base64url(raw)});
        if let Some(t) = thread_id {
            message["threadId"] = json!(t);
        }
        match draft_id {
            Some(id) => {
                self.request(
                    reqwest::Method::PUT,
                    &format!("/drafts/{id}"),
                    &[],
                    Some(json!({"id": id, "message": message})),
                )
                .await
            }
            None => self.post("/drafts", json!({"message": message})).await,
        }
    }

    pub async fn delete_draft(&self, id: &str) -> Result<()> {
        self.request(reqwest::Method::DELETE, &format!("/drafts/{id}"), &[], None)
            .await?;
        Ok(())
    }

    /// Draft ids with their current message ids.
    pub async fn draft_ids(&self) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        for _ in 0..5 {
            let mut query = vec![("maxResults", "100".to_string())];
            if let Some(p) = &page {
                query.push(("pageToken", p.clone()));
            }
            let v = self.get("/drafts", &query).await?;
            for d in v["drafts"].as_array().cloned().unwrap_or_default() {
                if let (Some(id), Some(mid)) = (d["id"].as_str(), d["message"]["id"].as_str()) {
                    out.push((id.to_string(), mid.to_string()));
                }
            }
            match v["nextPageToken"].as_str() {
                Some(p) => page = Some(p.to_string()),
                None => break,
            }
        }
        Ok(out)
    }

    pub async fn attachment(&self, message_id: &str, attachment_id: &str) -> Result<Vec<u8>> {
        let v = self
            .get(
                &format!("/messages/{message_id}/attachments/{attachment_id}"),
                &[],
            )
            .await?;
        let data = v["data"]
            .as_str()
            .ok_or_else(|| anyhow!("empty attachment"))?;
        decode_base64url(data)
    }

    pub async fn send_as(&self) -> Result<Vec<Value>> {
        let v = self.get("/settings/sendAs", &[]).await?;
        Ok(v["sendAs"].as_array().cloned().unwrap_or_default())
    }

    pub async fn set_signature(&self, email: &str, signature: &str) -> Result<()> {
        self.request(
            reqwest::Method::PATCH,
            &format!("/settings/sendAs/{}", enc(email)),
            &[],
            Some(json!({"signature": signature})),
        )
        .await?;
        Ok(())
    }
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

pub fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn decode_base64url(data: &str) -> Result<Vec<u8>> {
    let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let trimmed = cleaned.trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(&cleaned))
        .map_err(|e| anyhow!("bad base64: {e}"))
}

#[allow(unused)]
fn _bail() -> Result<()> {
    bail!("x")
}
