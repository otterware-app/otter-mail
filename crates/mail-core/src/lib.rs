//! Otter Mail's mail backend: the cache, the providers (Gmail, IMAP), sync,
//! and the stores that keep accounts and settings. Plain Rust, no UI: the
//! app drives it through `Backend`.

pub mod backend;
pub mod config;
pub mod demo;
mod demo_provider;
pub mod gmail;
pub mod google;
pub mod imap;
pub mod mime;
pub mod model;
pub mod paths;
pub mod provider;
pub mod search;
pub mod secrets;
pub mod store;
pub mod text;

pub use backend::{Backend, Event, SyncStatus, ThreadRef};

#[cfg(test)]
mod tests;
