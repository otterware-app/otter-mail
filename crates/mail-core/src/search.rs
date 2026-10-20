//! Gmail's search operators, for searching the cache (IMAP mailboxes, the
//! demo, and Gmail while offline).

use chrono::{Duration, NaiveDate, TimeZone, Utc};

use crate::model::SystemFolder;
use crate::store::LocalQuery;

/// Splits a query into terms, keeping "quoted phrases" and `op:"quoted"` whole.
fn terms(query: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in query.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn age(value: &str) -> Option<Duration> {
    let (n, unit) = value.split_at(value.len().checked_sub(1)?);
    let n: i64 = n.parse().ok()?;
    Some(match unit {
        "d" => Duration::days(n),
        "m" => Duration::days(n * 30),
        "y" => Duration::days(n * 365),
        "h" => Duration::hours(n),
        _ => return None,
    })
}

fn date(value: &str) -> Option<i64> {
    let normalized = value.replace('-', "/");
    let day = NaiveDate::parse_from_str(&normalized, "%Y/%m/%d").ok()?;
    Some(
        chrono::Local
            .from_local_datetime(&day.and_hms_opt(0, 0, 0)?)
            .single()?
            .timestamp_millis(),
    )
}

/// The query as a cache search in one mailbox (`label:` names are matched
/// against label ids by the caller when it knows them).
pub fn parse_query(query: &str, account_id: &str) -> LocalQuery {
    let mut q = LocalQuery {
        accounts: vec![account_id.to_string()],
        ..Default::default()
    };
    let mut free = Vec::new();
    let now = Utc::now().timestamp_millis();
    for term in terms(query) {
        let Some((op, value)) = term.split_once(':') else {
            free.push(term.trim_matches('"').to_string());
            continue;
        };
        let value = value.trim_matches('"').to_string();
        match op.to_ascii_lowercase().as_str() {
            "in" | "label" => {
                let v = value.to_ascii_lowercase();
                match v.as_str() {
                    "inbox" => q.label = Some("INBOX".into()),
                    "sent" => q.label = Some("SENT".into()),
                    "drafts" | "draft" => q.label = Some("DRAFT".into()),
                    "spam" | "junk" => q.label = Some("SPAM".into()),
                    "trash" => q.label = Some("TRASH".into()),
                    "starred" => q.starred = true,
                    "important" => q.important = true,
                    "anywhere" => q.anywhere = true,
                    _ => {
                        q.label = Some(
                            SystemFolder::from_label_id(&value.to_ascii_uppercase())
                                .map(|f| f.label_id().to_string())
                                .unwrap_or(value),
                        )
                    }
                }
            }
            "is" => match value.to_ascii_lowercase().as_str() {
                "unread" => q.unread = Some(true),
                "read" => q.unread = Some(false),
                "starred" | "flagged" => q.starred = true,
                "important" => q.important = true,
                _ => {}
            },
            "from" => q.from = Some(value),
            "to" | "cc" => q.to = Some(value),
            "subject" => q.subject = Some(value),
            "has" if value.eq_ignore_ascii_case("attachment") => q.has_attachments = true,
            "newer_than" => q.after = age(&value).map(|d| now - d.num_milliseconds()),
            "older_than" => q.before = age(&value).map(|d| now - d.num_milliseconds()),
            "after" | "newer" => q.after = date(&value),
            "before" | "older" => q.before = date(&value),
            _ => free.push(term.clone()),
        }
    }
    q.text = free.join(" ");
    q
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operators() {
        let q = parse_query(
            "from:maya is:unread has:attachment \"red wine\" in:inbox",
            "a",
        );
        assert_eq!(q.from.as_deref(), Some("maya"));
        assert_eq!(q.unread, Some(true));
        assert!(q.has_attachments);
        assert_eq!(q.label.as_deref(), Some("INBOX"));
        assert_eq!(q.text, "red wine");
    }
}
