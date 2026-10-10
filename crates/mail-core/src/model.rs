//! What the app shows: mailboxes, labels, conversations and their messages.

use serde::{Deserialize, Serialize};

pub type AccountId = String;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Gmail,
    Imap,
    Demo,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Account {
    /// The mailbox's address, lowercased.
    pub id: AccountId,
    pub email: String,
    /// The person's name (Google profile, or what they typed).
    pub name: Option<String>,
    /// What the user calls the mailbox ("Work"); the address when unset.
    pub display_name: Option<String>,
    /// The mailbox's color, `#rrggbb`.
    pub color: Option<String>,
    /// A profile picture URL (or data URL).
    pub picture: Option<String>,
    pub provider: ProviderKind,
    pub enabled: bool,
    pub position: i64,
    pub signature: Option<String>,
    /// Signed out elsewhere, or its token was revoked: shown, not synced.
    pub signed_out: bool,
}

impl Account {
    pub fn title(&self) -> &str {
        self.display_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.email)
    }

    pub fn initial(&self) -> String {
        self.title()
            .chars()
            .find(|c| c.is_alphanumeric())
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_else(|| "?".into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub enum SystemFolder {
    Inbox,
    Starred,
    Sent,
    Drafts,
    Important,
    All,
    Spam,
    Trash,
}

impl SystemFolder {
    pub const ALL: [SystemFolder; 8] = [
        SystemFolder::Inbox,
        SystemFolder::Starred,
        SystemFolder::Sent,
        SystemFolder::Drafts,
        SystemFolder::Important,
        SystemFolder::All,
        SystemFolder::Spam,
        SystemFolder::Trash,
    ];

    /// Gmail's label id for the folder (IMAP maps its folders onto these).
    pub fn label_id(&self) -> &'static str {
        match self {
            SystemFolder::Inbox => "INBOX",
            SystemFolder::Starred => "STARRED",
            SystemFolder::Sent => "SENT",
            SystemFolder::Drafts => "DRAFT",
            SystemFolder::Important => "IMPORTANT",
            SystemFolder::All => "ALL",
            SystemFolder::Spam => "SPAM",
            SystemFolder::Trash => "TRASH",
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            SystemFolder::Inbox => "Inbox",
            SystemFolder::Starred => "Starred",
            SystemFolder::Sent => "Sent",
            SystemFolder::Drafts => "Drafts",
            SystemFolder::Important => "Important",
            SystemFolder::All => "All Mail",
            SystemFolder::Spam => "Junk",
            SystemFolder::Trash => "Trash",
        }
    }

    pub fn route(&self) -> &'static str {
        match self {
            SystemFolder::Inbox => "inbox",
            SystemFolder::Starred => "starred",
            SystemFolder::Sent => "sent",
            SystemFolder::Drafts => "drafts",
            SystemFolder::Important => "important",
            SystemFolder::All => "all",
            SystemFolder::Spam => "junk",
            SystemFolder::Trash => "trash",
        }
    }

    pub fn from_label_id(id: &str) -> Option<SystemFolder> {
        SystemFolder::ALL.into_iter().find(|f| f.label_id() == id)
    }
}

/// Labels Gmail keeps that aren't folders the user picks.
pub const HIDDEN_LABELS: &[&str] = &[
    "UNREAD",
    "CHAT",
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
    "YELLOW_STAR",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Label {
    pub account_id: AccountId,
    pub id: String,
    /// Full name; `/` nests ("Projects/Otter").
    pub name: String,
    pub system: bool,
    pub background_color: Option<String>,
    pub text_color: Option<String>,
    pub unread: i64,
    pub total: i64,
}

impl Label {
    /// The last path segment.
    pub fn leaf_name(&self) -> &str {
        self.name.rsplit('/').next().unwrap_or(&self.name)
    }

    pub fn depth(&self) -> usize {
        self.name.matches('/').count()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Person {
    pub name: Option<String>,
    pub email: String,
}

impl Person {
    pub fn display(&self) -> &str {
        self.name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&self.email)
    }

    /// "Ada Lovelace <ada@example.com>", or the bare address.
    pub fn to_header(&self) -> String {
        match self.name.as_deref().filter(|n| !n.is_empty()) {
            Some(name) if name.contains([',', '"', '<', '>', '@', ';']) => {
                format!("\"{}\" <{}>", name.replace('"', ""), self.email)
            }
            Some(name) => format!("{name} <{}>", self.email),
            None => self.email.clone(),
        }
    }
}

/// Which conversations a list shows: one mailbox, or every enabled one.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Scope {
    All,
    Account(AccountId),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Folder {
    System(SystemFolder),
    /// A user label, by id (in one mailbox).
    Label(String),
    /// Search results for a query (Gmail operators).
    Search(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Mailbox {
    pub scope: Scope,
    pub folder: Folder,
}

impl Mailbox {
    pub fn inbox(scope: Scope) -> Self {
        Mailbox {
            scope,
            folder: Folder::System(SystemFolder::Inbox),
        }
    }
}

/// One conversation's row in the list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub account_id: AccountId,
    pub id: String,
    pub subject: String,
    pub snippet: String,
    /// Who wrote the messages, oldest first, without repeats.
    pub senders: Vec<Person>,
    /// Newest message's time, ms since the epoch.
    pub date: i64,
    pub message_count: i64,
    pub unread: bool,
    pub starred: bool,
    pub has_attachments: bool,
    /// The thread has an unsent draft; its recipients when it's only a draft.
    pub draft: bool,
    pub draft_only: bool,
    pub draft_to: Vec<Person>,
    pub label_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    /// Gmail attachment id, or the MIME part path.
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    /// `cid:` images in the HTML body.
    pub content_id: Option<String>,
    pub inline: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub account_id: AccountId,
    pub id: String,
    pub thread_id: String,
    pub date: i64,
    pub from: Person,
    pub to: Vec<Person>,
    pub cc: Vec<Person>,
    pub bcc: Vec<Person>,
    pub reply_to: Vec<Person>,
    pub subject: String,
    pub snippet: String,
    pub label_ids: Vec<String>,
    pub unread: bool,
    pub starred: bool,
    pub draft: bool,
    /// None until the body is downloaded.
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub attachments: Vec<Attachment>,
    pub message_id_header: Option<String>,
    pub references: Option<String>,
    pub in_reply_to: Option<String>,
    pub list_unsubscribe: Option<String>,
    pub list_unsubscribe_post: Option<String>,
}

impl Message {
    pub fn has_body(&self) -> bool {
        self.body_html.is_some() || self.body_text.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Thread {
    pub account_id: AccountId,
    pub id: String,
    pub subject: String,
    pub messages: Vec<Message>,
    pub label_ids: Vec<String>,
}

/// Changes to conversations the user makes (and undoes).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ThreadAction {
    Archive,
    MoveToInbox,
    Trash,
    Untrash,
    Spam,
    NotSpam,
    DeleteForever,
    MarkRead,
    MarkUnread,
    Star,
    Unstar,
    AddLabel(String),
    RemoveLabel(String),
    /// Move to a label: add it and leave the inbox.
    MoveToLabel(String),
}

impl ThreadAction {
    /// The action that puts things back, when there is one.
    pub fn inverse(&self) -> Option<ThreadAction> {
        Some(match self {
            ThreadAction::Archive => ThreadAction::MoveToInbox,
            ThreadAction::MoveToInbox => ThreadAction::Archive,
            ThreadAction::Trash => ThreadAction::Untrash,
            ThreadAction::Untrash => ThreadAction::Trash,
            ThreadAction::Spam => ThreadAction::NotSpam,
            ThreadAction::NotSpam => ThreadAction::Spam,
            ThreadAction::MarkRead => ThreadAction::MarkUnread,
            ThreadAction::MarkUnread => ThreadAction::MarkRead,
            ThreadAction::Star => ThreadAction::Unstar,
            ThreadAction::Unstar => ThreadAction::Star,
            ThreadAction::AddLabel(id) => ThreadAction::RemoveLabel(id.clone()),
            ThreadAction::RemoveLabel(id) => ThreadAction::AddLabel(id.clone()),
            ThreadAction::MoveToLabel(_) | ThreadAction::DeleteForever => return None,
        })
    }

    /// Labels added and removed, Gmail's way.
    pub fn label_changes(&self) -> (Vec<String>, Vec<String>) {
        let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        match self {
            ThreadAction::Archive => (vec![], s(&["INBOX"])),
            ThreadAction::MoveToInbox => (s(&["INBOX"]), s(&["TRASH", "SPAM"])),
            // Trash keeps the other labels (Gmail restores them on untrash);
            // lists leave out what's in the Trash.
            ThreadAction::Trash => (s(&["TRASH"]), s(&["SPAM"])),
            ThreadAction::Untrash => (vec![], s(&["TRASH"])),
            ThreadAction::Spam => (s(&["SPAM"]), s(&["INBOX", "TRASH"])),
            ThreadAction::NotSpam => (s(&["INBOX"]), s(&["SPAM"])),
            ThreadAction::MarkRead => (vec![], s(&["UNREAD"])),
            ThreadAction::MarkUnread => (s(&["UNREAD"]), vec![]),
            ThreadAction::Star => (s(&["STARRED"]), vec![]),
            ThreadAction::Unstar => (vec![], s(&["STARRED"])),
            ThreadAction::AddLabel(id) => (vec![id.clone()], vec![]),
            ThreadAction::RemoveLabel(id) => (vec![], vec![id.clone()]),
            ThreadAction::MoveToLabel(id) => (vec![id.clone()], s(&["INBOX"])),
            ThreadAction::DeleteForever => (vec![], vec![]),
        }
    }

    /// Does the conversation leave a list showing `folder`?
    pub fn removes_from(&self, folder: &Folder) -> bool {
        let (added, removed) = self.label_changes();
        match folder {
            Folder::System(SystemFolder::All) => matches!(
                self,
                ThreadAction::Trash | ThreadAction::Spam | ThreadAction::DeleteForever
            ),
            Folder::System(f) => {
                matches!(self, ThreadAction::DeleteForever)
                    || removed.iter().any(|id| id == f.label_id())
                    || (added.iter().any(|id| id == "TRASH" || id == "SPAM")
                        && !matches!(f, SystemFolder::Trash | SystemFolder::Spam))
            }
            Folder::Label(id) => {
                matches!(
                    self,
                    ThreadAction::DeleteForever | ThreadAction::Trash | ThreadAction::Spam
                ) || removed.contains(id)
            }
            Folder::Search(_) => matches!(self, ThreadAction::DeleteForever),
        }
    }
}

/// What a new message, reply or forward is made of.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    pub account_id: AccountId,
    /// The draft's id once saved in the mailbox.
    pub draft_id: Option<String>,
    pub thread_id: Option<String>,
    pub to: Vec<Person>,
    pub cc: Vec<Person>,
    pub bcc: Vec<Person>,
    pub subject: String,
    pub body_html: String,
    pub body_text: String,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub attachments: Vec<OutgoingAttachment>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    #[serde(with = "base64_bytes")]
    pub data: Vec<u8>,
}

mod base64_bytes {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(s)
            .map_err(serde::de::Error::custom)
    }
}
