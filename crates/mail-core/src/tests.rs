use crate::model::*;
use crate::store::{HistoryOp, LocalQuery, Store, ViewRule};

fn seeded() -> (Store, Vec<Account>) {
    let store = Store::open_in_memory().unwrap();
    let mut accounts = Vec::new();
    for mailbox in crate::demo::mailboxes(1_760_000_000_000) {
        store
            .replace_labels(&mailbox.account.id, &mailbox.labels)
            .unwrap();
        store.upsert_details(&mailbox.messages).unwrap();
        store.recount_labels(&mailbox.account.id).unwrap();
        accounts.push(mailbox.account);
    }
    (store, accounts)
}

fn inbox(account: &str) -> ViewRule {
    ViewRule {
        account_id: account.into(),
        all_of: vec!["INBOX".into()],
        none_of: vec![],
    }
}

#[test]
fn lists_inbox_newest_first() {
    let (store, accounts) = seeded();
    let (rows, more) = store
        .threads_page(&[inbox(&accounts[0].id)], 0, 50)
        .unwrap();
    assert!(!more);
    assert!(rows.len() > 10);
    assert!(rows.windows(2).all(|w| w[0].date >= w[1].date));
    let dinner = rows.iter().find(|r| r.subject.contains("Dinner")).unwrap();
    assert_eq!(dinner.message_count, 3);
    assert!(
        !rows
            .iter()
            .any(|r| r.label_ids.contains(&"SPAM".to_string()))
    );
}

#[test]
fn combines_mailboxes() {
    let (store, accounts) = seeded();
    let rules: Vec<_> = accounts.iter().map(|a| inbox(&a.id)).collect();
    let (all, _) = store.threads_page(&rules, 0, 500).unwrap();
    let (one, _) = store.threads_page(&rules[..1], 0, 500).unwrap();
    assert!(all.len() > one.len());
}

#[test]
fn archive_leaves_inbox_and_counts() {
    let (store, accounts) = seeded();
    let account = &accounts[0].id;
    let (rows, _) = store.threads_page(&[inbox(account)], 0, 50).unwrap();
    let thread = &rows[0];
    let ids = store.thread_message_ids(account, &thread.id).unwrap();
    store
        .apply_label_change(account, &ids, &[], &["INBOX".into()])
        .unwrap();
    let (after, _) = store.threads_page(&[inbox(account)], 0, 50).unwrap();
    assert_eq!(after.len(), rows.len() - 1);
    let inbox_label = store
        .labels(account)
        .unwrap()
        .into_iter()
        .find(|l| l.id == "INBOX")
        .unwrap();
    assert!(inbox_label.total > 0);
}

#[test]
fn history_ops_and_unknown_ids() {
    let (store, accounts) = seeded();
    let account = &accounts[0].id;
    let (rows, _) = store.threads_page(&[inbox(account)], 0, 1).unwrap();
    let id = store.thread_message_ids(account, &rows[0].id).unwrap()[0].clone();
    let unknown = store
        .apply_history(
            account,
            &[
                HistoryOp::LabelsAdded {
                    id: id.clone(),
                    labels: vec!["STARRED".into()],
                },
                HistoryOp::LabelsAdded {
                    id: "nope".into(),
                    labels: vec!["INBOX".into()],
                },
            ],
        )
        .unwrap();
    assert_eq!(unknown, vec!["nope".to_string()]);
    assert!(store.message(account, &id).unwrap().unwrap().starred);
    store
        .apply_history(account, &[HistoryOp::Deleted { id: id.clone() }])
        .unwrap();
    assert!(store.message(account, &id).unwrap().is_none());
}

#[test]
fn pending_writes_survive_stale_reads() {
    let (store, accounts) = seeded();
    let account = &accounts[0].id;
    let (rows, _) = store.threads_page(&[inbox(account)], 0, 1).unwrap();
    let ids = store.thread_message_ids(account, &rows[0].id).unwrap();
    store.begin_pending(account, &ids, &[], &["INBOX".to_string()]);
    store
        .apply_label_change(account, &ids, &[], &["INBOX".into()])
        .unwrap();
    // A sync reads the old labels back.
    let stale: Vec<Message> = ids
        .iter()
        .map(|id| store.message(account, id).unwrap().unwrap())
        .map(|mut m| {
            m.label_ids.push("INBOX".into());
            m
        })
        .collect();
    store.upsert_summaries(&stale).unwrap();
    let m = store.message(account, &ids[0]).unwrap().unwrap();
    assert!(!m.label_ids.contains(&"INBOX".to_string()));
}

#[test]
fn searches_text() {
    let (store, accounts) = seeded();
    let q = LocalQuery {
        text: "lisbon".into(),
        accounts: vec![accounts[0].id.clone()],
        ..Default::default()
    };
    let (rows, _) = store.search_threads(&q, 0, 20).unwrap();
    assert!(rows.iter().any(|r| r.subject.contains("Lisbon")));
    let contacts = store.suggest_contacts("maya", 5).unwrap();
    assert!(contacts.iter().any(|c| c.email.contains("maya")));
}
