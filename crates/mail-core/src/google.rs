//! Google sign-in for the desktop app: the installed-app flow (RFC 8252) with
//! PKCE and a loopback redirect, and the tokens it yields, sealed in
//! `google-tokens.json` the way the Electron app kept them.
//!
//! The OAuth client is the "Desktop app" client the Electron app used (its id
//! and secret come from the environment at build or run time), so existing
//! refresh tokens keep working.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail};
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::paths::{Paths, write_json};
use crate::secrets::{Sealer, read_json};

const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
const LOOPBACK_PORT: u16 = 42813;
const REFRESH_AHEAD_MS: i64 = 2 * 60_000;

pub const GMAIL_SCOPES: &[&str] = &[
    "https://mail.google.com/",
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/contacts.other.readonly",
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/gmail.settings.basic",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    access_token: String,
    refresh_token: String,
    /// Epoch ms.
    expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct TokenFile {
    version: u32,
    accounts: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

/// The sign-in expired or was revoked: the mailbox reads "signed out".
#[derive(Debug)]
pub struct SignInExpired;

impl std::fmt::Display for SignInExpired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "The Google sign-in expired; sign in again")
    }
}

impl std::error::Error for SignInExpired {}

#[derive(Clone)]
struct Client {
    id: String,
    secret: String,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn current_client() -> Option<Client> {
    let id = env("OTTER_MAIL_GOOGLE_CLIENT_ID")
        .or(option_env!("OTTER_MAIL_GOOGLE_CLIENT_ID").map(String::from))?;
    let secret = env("OTTER_MAIL_GOOGLE_CLIENT_SECRET")
        .or(option_env!("OTTER_MAIL_GOOGLE_CLIENT_SECRET").map(String::from))?;
    Some(Client { id, secret })
}

fn legacy_client() -> Option<Client> {
    let id = env("OTTER_MAIL_GOOGLE_LEGACY_CLIENT_ID")
        .or(option_env!("OTTER_MAIL_GOOGLE_LEGACY_CLIENT_ID").map(String::from))?;
    let secret = env("OTTER_MAIL_GOOGLE_LEGACY_CLIENT_SECRET")
        .or(option_env!("OTTER_MAIL_GOOGLE_LEGACY_CLIENT_SECRET").map(String::from))?;
    Some(Client { id, secret })
}

/// The client that issued a grant (refresh tokens are bound to it).
fn client_for(issued_to: Option<&str>) -> Result<Client> {
    let current =
        current_client().ok_or_else(|| anyhow!("This build has no Google client configured"))?;
    match issued_to {
        Some(id) if id == current.id => Ok(current),
        None => Ok(legacy_client().unwrap_or(current)),
        Some(id) => match legacy_client() {
            Some(legacy) if legacy.id == id => Ok(legacy),
            _ => bail!("This build cannot refresh this Google sign-in"),
        },
    }
}

pub fn configured() -> bool {
    current_client().is_some()
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random(n: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; n];
    rand::fill(&mut bytes[..]);
    bytes
}

pub struct GoogleAuth {
    path: Option<std::path::PathBuf>,
    sealer: Arc<Sealer>,
    tokens: Mutex<HashMap<String, StoredTokens>>,
    refreshing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    http: reqwest::Client,
}

impl GoogleAuth {
    pub fn load(paths: &Paths, sealer: Arc<Sealer>) -> Result<GoogleAuth> {
        let path = paths.file("google-tokens.json");
        let file: TokenFile = read_json(&path)?;
        let mut tokens = HashMap::new();
        for (email, sealed) in &file.accounts {
            let token = sealer
                .unseal(sealed)
                .and_then(|json| Ok(serde_json::from_str::<StoredTokens>(&json)?))
                .context("opening the saved Google sign-ins")?;
            tokens.insert(email.clone(), token);
        }
        Ok(GoogleAuth {
            path: Some(path),
            sealer,
            tokens: Mutex::new(tokens),
            refreshing: Mutex::new(HashMap::new()),
            cancel: Mutex::new(None),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("http client"),
        })
    }

    pub fn empty(sealer: Arc<Sealer>) -> GoogleAuth {
        GoogleAuth {
            path: None,
            sealer,
            tokens: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashMap::new()),
            cancel: Mutex::new(None),
            http: reqwest::Client::new(),
        }
    }

    pub fn has_tokens(&self, email: &str) -> bool {
        self.tokens.lock().contains_key(email)
    }

    pub(crate) fn protect(&self) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let mut file: TokenFile = read_json(path)?;
        if self.sealer.protect(&mut file.accounts)? {
            write_json(path, &file)?;
        }
        Ok(())
    }

    fn save(&self, tokens: &HashMap<String, StoredTokens>) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let mut file = TokenFile {
            version: 1,
            accounts: BTreeMap::new(),
        };
        for (email, t) in tokens {
            file.accounts
                .insert(email.clone(), self.sealer.seal(&serde_json::to_string(t)?)?);
        }
        write_json(path, &file)
    }

    pub fn remove(&self, email: &str) -> Result<()> {
        let mut current = self.tokens.lock();
        let mut tokens = current.clone();
        if tokens.remove(email).is_some() {
            self.save(&tokens)?;
            *current = tokens;
        }
        Ok(())
    }

    fn store(&self, email: &str, token: StoredTokens) -> Result<()> {
        let mut current = self.tokens.lock();
        let mut tokens = current.clone();
        tokens.insert(email.to_string(), token);
        self.save(&tokens)?;
        *current = tokens;
        Ok(())
    }

    /// Keeps a refresh token (the access token comes on first use).
    pub fn store_refresh_token(&self, email: &str, refresh_token: &str) -> Result<()> {
        self.store(
            email,
            StoredTokens {
                client_id: current_client().map(|c| c.id),
                access_token: String::new(),
                refresh_token: refresh_token.to_string(),
                expires_at: 0,
                scope: None,
            },
        )
    }

    /// A current access token for the mailbox, refreshed when needed.
    pub async fn access_token(&self, email: &str, force_refresh: bool) -> Result<String> {
        let lock = self
            .refreshing
            .lock()
            .entry(email.to_string())
            .or_default()
            .clone();
        let _guard = lock.lock().await;
        let stored = self
            .tokens
            .lock()
            .get(email)
            .cloned()
            .ok_or(SignInExpired)?;
        let now = chrono::Utc::now().timestamp_millis();
        if !force_refresh
            && !stored.access_token.is_empty()
            && stored.expires_at - REFRESH_AHEAD_MS > now
        {
            return Ok(stored.access_token);
        }
        let client = client_for(stored.client_id.as_deref())?;
        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("client_id", client.id.as_str()),
                ("client_secret", client.secret.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", stored.refresh_token.as_str()),
            ])
            .send()
            .await
            .context("refreshing the Google sign-in")?;
        let status = response.status();
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        if !status.is_success() {
            if body["error"] == "invalid_grant" {
                self.remove(email)?;
                return Err(SignInExpired.into());
            }
            bail!("Google token refresh failed: {status} {}", body["error"]);
        }
        let access_token = body["access_token"]
            .as_str()
            .ok_or_else(|| anyhow!("no access token"))?
            .to_string();
        let expires_in = body["expires_in"].as_i64().unwrap_or(3600);
        let updated = StoredTokens {
            client_id: Some(client.id.clone()),
            access_token: access_token.clone(),
            refresh_token: body["refresh_token"]
                .as_str()
                .map(String::from)
                .unwrap_or(stored.refresh_token),
            expires_at: chrono::Utc::now().timestamp_millis() + expires_in * 1000,
            scope: body["scope"].as_str().map(String::from).or(stored.scope),
        };
        self.store(email, updated)?;
        Ok(access_token)
    }

    pub fn cancel_sign_in(&self) {
        if let Some(cancel) = self.cancel.lock().take() {
            let _ = cancel.send(());
        }
    }

    /// Signs a Google account in through the browser.
    pub async fn sign_in(&self, login_hint: Option<String>) -> Result<Profile> {
        self.cancel_sign_in();
        let client = current_client()
            .ok_or_else(|| anyhow!("This build has no Google client configured"))?;
        let verifier = base64url(&random(32));
        let challenge = base64url(&sha2::Sha256::digest(verifier.as_bytes()));
        let state = base64url(&random(16));
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", LOOPBACK_PORT)).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let port = listener.local_addr()?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}");
        let mut url = url::Url::parse(AUTHORIZE_URL)?;
        url.query_pairs_mut()
            .append_pair("client_id", &client.id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &GMAIL_SCOPES.join(" "))
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        if let Some(hint) = &login_hint {
            url.query_pairs_mut().append_pair("login_hint", hint);
        }
        open::that_detached(url.as_str()).context("opening the browser")?;

        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        *self.cancel.lock() = Some(cancel_tx);
        let code = tokio::select! {
            code = wait_for_code(listener, state) => code?,
            _ = cancel_rx => bail!("cancelled"),
            _ = tokio::time::sleep(Duration::from_secs(300)) => bail!("The sign-in timed out"),
        };

        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("client_id", client.id.as_str()),
                ("client_secret", client.secret.as_str()),
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("redirect_uri", redirect_uri.as_str()),
                ("code_verifier", verifier.as_str()),
            ])
            .send()
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        if !status.is_success() {
            bail!("Google sign-in failed: {status} {}", body["error"]);
        }
        let access_token = body["access_token"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let refresh_token = body["refresh_token"]
            .as_str()
            .ok_or_else(|| anyhow!("Google didn't return a refresh token"))?
            .to_string();
        let profile = self.profile(&access_token).await?;
        self.store(
            &profile.email,
            StoredTokens {
                client_id: Some(client.id.clone()),
                access_token,
                refresh_token,
                expires_at: chrono::Utc::now().timestamp_millis()
                    + body["expires_in"].as_i64().unwrap_or(3600) * 1000,
                scope: body["scope"].as_str().map(String::from),
            },
        )?;
        Ok(profile)
    }

    pub async fn profile(&self, access_token: &str) -> Result<Profile> {
        let mut attempt = 0;
        loop {
            let response = self
                .http
                .get(USERINFO_URL)
                .bearer_auth(access_token)
                .send()
                .await?;
            if response.status().is_server_error() && attempt < 3 {
                attempt += 1;
                tokio::time::sleep(Duration::from_secs(attempt)).await;
                continue;
            }
            let info: serde_json::Value = response.error_for_status()?.json().await?;
            let email = info["email"]
                .as_str()
                .ok_or_else(|| anyhow!("Google didn't say which account this is"))?;
            return Ok(Profile {
                email: email.to_string(),
                name: info["name"].as_str().map(String::from),
                picture: info["picture"].as_str().map(String::from),
            });
        }
    }
}

/// Answers the browser's redirect and returns the authorization code.
async fn wait_for_code(listener: tokio::net::TcpListener, state: String) -> Result<String> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let path = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/");
        let url = url::Url::parse(&format!("http://127.0.0.1{path}"))?;
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        let (status, page, result) = if let Some(error) = params.get("error") {
            (
                "400 Bad Request",
                "Sign-in was cancelled. You can close this tab.",
                Some(Err(anyhow!("Google sign-in: {error}"))),
            )
        } else if let Some(code) = params.get("code") {
            if params.get("state") != Some(&state) {
                (
                    "400 Bad Request",
                    "This sign-in link is stale. Start again from Otter Mail.",
                    Some(Err(anyhow!("stale sign-in"))),
                )
            } else {
                (
                    "200 OK",
                    "Signed in. You can close this tab and return to Otter Mail.",
                    Some(Ok(code.clone())),
                )
            }
        } else {
            ("404 Not Found", "", None)
        };
        let html = format!(
            "<!doctype html><meta charset=utf-8><title>Otter Mail</title><body style=\"font:15px -apple-system,system-ui;display:grid;place-items:center;height:90vh;color:#333\"><p>{page}</p>"
        );
        let _ = socket
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                    html.len()
                )
                .as_bytes(),
            )
            .await;
        if let Some(result) = result {
            return result;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::test_sealer;

    #[test]
    fn migrates_and_reopens_all_saved_google_sign_ins() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path(), true);
        let legacy = GoogleAuth::load(&paths, Arc::new(Sealer::plain())).unwrap();
        legacy
            .store_refresh_token("one@example.test", "fake-refresh-one")
            .unwrap();
        legacy
            .store_refresh_token("two@example.test", "fake-refresh-two")
            .unwrap();
        drop(legacy);

        let protected = GoogleAuth::load(&paths, Arc::new(test_sealer())).unwrap();
        protected.protect().unwrap();
        assert_eq!(
            protected.tokens.lock()["one@example.test"].refresh_token,
            "fake-refresh-one"
        );
        let saved: TokenFile = read_json(&paths.file("google-tokens.json")).unwrap();
        assert_eq!(saved.accounts.len(), 2);
        for sealed in saved.accounts.values() {
            assert!(
                base64::engine::general_purpose::STANDARD
                    .decode(sealed)
                    .unwrap()
                    .starts_with(b"v10")
            );
        }
        let reopened = GoogleAuth::load(&paths, Arc::new(test_sealer())).unwrap();
        assert!(reopened.has_tokens("one@example.test"));
        assert_eq!(
            reopened.tokens.lock()["two@example.test"].refresh_token,
            "fake-refresh-two"
        );
    }

    #[test]
    fn one_unreadable_sign_in_preserves_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path(), true);
        let legacy = GoogleAuth::load(&paths, Arc::new(Sealer::plain())).unwrap();
        legacy
            .store_refresh_token("valid@example.test", "fake-refresh")
            .unwrap();
        let mut saved: TokenFile = read_json(&paths.file("google-tokens.json")).unwrap();
        saved
            .accounts
            .insert("broken@example.test".into(), "not base64!".into());
        write_json(&paths.file("google-tokens.json"), &saved).unwrap();
        let before = std::fs::read(paths.file("google-tokens.json")).unwrap();
        assert!(GoogleAuth::load(&paths, Arc::new(test_sealer())).is_err());
        assert_eq!(
            std::fs::read(paths.file("google-tokens.json")).unwrap(),
            before
        );
    }

    #[test]
    fn failed_save_does_not_report_a_persisted_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path(), true);
        let auth = GoogleAuth::load(&paths, Arc::new(test_sealer())).unwrap();
        std::fs::create_dir(paths.file("google-tokens.json")).unwrap();
        assert!(
            auth.store_refresh_token("demo@example.test", "fake-refresh")
                .is_err()
        );
        assert!(!auth.has_tokens("demo@example.test"));
    }
}
