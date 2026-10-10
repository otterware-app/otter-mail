//! Where Otter Mail keeps its data, as the Electron app did: a data home
//! (`~/.otter-mail`, or `OTTER_MAIL_HOME`) holding one state dir per kind of
//! run, so development never shares a database with the installed app.
//!
//! - release build:                  ~/.otter-mail/userdata (the Electron app's)
//! - debug build:                    ~/.otter-mail/dev-native
//! - explicit OTTER_MAIL_HOME:       $OTTER_MAIL_HOME/userdata

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Paths {
    pub state_dir: PathBuf,
    /// Development runs use their own data directory and credential-store item.
    pub dev: bool,
}

impl Paths {
    pub fn resolve() -> Paths {
        let dev = cfg!(debug_assertions);
        let configured = std::env::var("OTTER_MAIL_HOME")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let home = configured
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".otter-mail"));
        let state_dir = home.join(if dev && configured.is_none() {
            "dev-native"
        } else {
            "userdata"
        });
        Paths { state_dir, dev }
    }

    pub fn at(state_dir: impl Into<PathBuf>, dev: bool) -> Paths {
        Paths {
            state_dir: state_dir.into(),
            dev,
        }
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.state_dir.join(name)
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.state_dir)?;
        std::fs::create_dir_all(self.state_dir.join("logs"))?;
        Ok(())
    }
}

/// Writes through a temp file and a rename, readable only by the user.
pub fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(err) => {
            log::warn!("couldn't read {}: {err}", path.display());
            None
        }
    }
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    let text = serde_json::to_string_pretty(value)?;
    write_atomic(path, text.as_bytes())?;
    Ok(())
}
