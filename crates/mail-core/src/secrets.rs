//! Sealed secrets, compatible with what the Electron app stored through
//! safeStorage (Chromium's OSCrypt on macOS): a random password in a Keychain
//! item ("Otter Mail Safe Storage" / "Otter Mail Key"), stretched with PBKDF2
//! into an AES-128-CBC key; sealed values are `v10` + ciphertext, base64.
//! So the native app opens an existing install's Gmail sign-ins as they are.
//!
//! Persistent macOS runs use the Keychain in development too, under a separate
//! item. The made-up mailbox needs no Keychain access. Older development files
//! are encrypted when opened; an inaccessible key never falls back to plain.

use std::collections::BTreeMap;

use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use anyhow::{Context as _, Result, anyhow};
use base64::Engine as _;
use parking_lot::Mutex;

use crate::paths::{Paths, write_json};

type Enc = cbc::Encryptor<aes::Aes128>;
type Dec = cbc::Decryptor<aes::Aes128>;

const PREFIX: &[u8] = b"v10";
const IV: [u8; 16] = [b' '; 16];

pub struct Sealer {
    /// None: the in-memory demo, or development on other platforms.
    keychain: Option<keyring::Entry>,
    key: Mutex<Option<[u8; 16]>>,
}

impl Sealer {
    pub fn new(paths: &Paths) -> Result<Sealer> {
        let protected = cfg!(target_os = "macos")
            || !paths.dev
            || std::env::var_os("OTTER_MAIL_KEYCHAIN").is_some();
        let name = if paths.dev {
            "Otter Mail (Dev)"
        } else {
            "Otter Mail"
        };
        let keychain = protected
            .then(|| keyring::Entry::new(&format!("{name} Safe Storage"), &format!("{name} Key")))
            .transpose()
            .context("opening the credential store")?;
        Ok(Sealer {
            keychain,
            key: Mutex::new(None),
        })
    }

    pub fn plain() -> Sealer {
        Sealer {
            keychain: None,
            key: Mutex::new(None),
        }
    }

    fn key(&self, create: bool) -> Result<Option<[u8; 16]>> {
        let Some(entry) = &self.keychain else {
            return Ok(None);
        };
        let mut cached = self.key.lock();
        if let Some(key) = *cached {
            return Ok(Some(key));
        }
        let password = match entry.get_password() {
            Ok(password) => password,
            Err(keyring::Error::NoEntry) if create => {
                let mut bytes = [0u8; 16];
                rand::fill(&mut bytes);
                let password = base64::engine::general_purpose::STANDARD.encode(bytes);
                entry
                    .set_password(&password)
                    .context("saving the encryption key in the credential store")?;
                password
            }
            Err(keyring::Error::NoEntry) => {
                return Err(anyhow!(
                    "The saved encryption key is missing from the credential store"
                ));
            }
            Err(err) => return Err(err).context("accessing the credential store"),
        };
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
        *cached = Some(key);
        Ok(Some(key))
    }

    pub fn seal(&self, text: &str) -> Result<String> {
        let sealed = match self.key(true)? {
            Some(key) => {
                let mut out = PREFIX.to_vec();
                out.extend(
                    Enc::new(&key.into(), &IV.into())
                        .encrypt_padded_vec_mut::<Pkcs7>(text.as_bytes()),
                );
                out
            }
            None => text.as_bytes().to_vec(),
        };
        Ok(base64::engine::general_purpose::STANDARD.encode(sealed))
    }

    pub fn unseal(&self, sealed: &str) -> Result<String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(sealed.trim())?;
        let plain = match bytes.strip_prefix(PREFIX) {
            Some(cipher) => {
                let key = self
                    .key(false)?
                    .ok_or_else(|| anyhow!("sealed with the Keychain"))?;
                Dec::new(&key.into(), &IV.into())
                    .decrypt_padded_vec_mut::<Pkcs7>(cipher)
                    .map_err(|_| anyhow!("couldn't unseal"))?
            }
            None => bytes,
        };
        Ok(String::from_utf8(plain)?)
    }

    /// Validate every value before replacing older, base64-only values.
    pub(crate) fn protect(&self, values: &mut BTreeMap<String, String>) -> Result<bool> {
        if self.keychain.is_none() {
            return Ok(false);
        }
        let mut plain = Vec::new();
        for (name, sealed) in values.iter() {
            let value = self.unseal(sealed).context("opening saved credentials")?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(sealed.trim())?;
            if !bytes.starts_with(PREFIX) {
                plain.push((name.clone(), value));
            }
        }
        let changed = !plain.is_empty();
        for (name, value) in plain {
            values.insert(name, self.seal(&value)?);
        }
        Ok(changed)
    }
}

/// `secrets.json`: named sealed values (IMAP passwords, the Otter session…).
pub struct Secrets {
    path: Option<std::path::PathBuf>,
    sealer: std::sync::Arc<Sealer>,
    values: Mutex<BTreeMap<String, String>>,
}

impl Secrets {
    pub fn load(paths: &Paths, sealer: std::sync::Arc<Sealer>) -> Result<Secrets> {
        let path = paths.file("secrets.json");
        let values: BTreeMap<String, String> = read_json(&path)?;
        for value in values.values() {
            sealer.unseal(value).context("opening saved credentials")?;
        }
        Ok(Secrets {
            path: Some(path),
            sealer,
            values: Mutex::new(values),
        })
    }

    pub fn in_memory(sealer: std::sync::Arc<Sealer>) -> Secrets {
        Secrets {
            path: None,
            sealer,
            values: Mutex::new(BTreeMap::new()),
        }
    }

    pub(crate) fn protect(&self) -> Result<()> {
        let mut current = self.values.lock();
        let mut values = current.clone();
        if self.sealer.protect(&mut values)? {
            if let Some(path) = &self.path {
                write_json(path, &values)?;
            }
            *current = values;
        }
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<String> {
        let sealed = self.values.lock().get(name).cloned()?;
        match self.sealer.unseal(&sealed) {
            Ok(value) => Some(value),
            Err(err) => {
                log::warn!("couldn't unseal {name}: {err}");
                None
            }
        }
    }

    pub fn set(&self, name: &str, value: Option<&str>) -> Result<()> {
        let mut current = self.values.lock();
        let mut values = current.clone();
        match value {
            Some(value) => {
                values.insert(name.to_string(), self.sealer.seal(value)?);
            }
            None => {
                values.remove(name);
            }
        }
        if let Some(path) = &self.path {
            write_json(path, &values)?;
        }
        *current = values;
        Ok(())
    }
}

/// Credential files must not silently become empty on read/parse errors.
pub(crate) fn read_json<T: serde::de::DeserializeOwned + Default>(
    path: &std::path::Path,
) -> Result<T> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("parsing saved credentials"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(err) => Err(err).context("reading saved credentials"),
    }
}

#[cfg(test)]
pub(crate) fn test_sealer() -> Sealer {
    let entry =
        keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
    entry.set_password("peanuts").unwrap();
    Sealer {
        keychain: Some(entry),
        key: Mutex::new(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_round_trip() {
        let sealer = Sealer::plain();
        let sealed = sealer.seal("hello").unwrap();
        assert_eq!(sealer.unseal(&sealed).unwrap(), "hello");
    }

    #[test]
    fn oscrypt_round_trip() {
        let key = {
            let mut key = [0u8; 16];
            pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"peanuts", b"saltysalt", 1003, &mut key);
            key
        };
        let mut sealed = PREFIX.to_vec();
        sealed.extend(Enc::new(&key.into(), &IV.into()).encrypt_padded_vec_mut::<Pkcs7>(b"secret"));
        let b64 = base64::engine::general_purpose::STANDARD.encode(sealed);
        let with_key = test_sealer();
        assert_eq!(with_key.unseal(&b64).unwrap(), "secret");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_development_uses_a_separate_keychain_item() {
        let dev = Sealer::new(&Paths::at("unused", true)).unwrap();
        let release = Sealer::new(&Paths::at("unused", false)).unwrap();
        let dev: &keyring::macos::MacCredential = dev
            .keychain
            .as_ref()
            .unwrap()
            .get_credential()
            .downcast_ref()
            .unwrap();
        let release: &keyring::macos::MacCredential = release
            .keychain
            .as_ref()
            .unwrap()
            .get_credential()
            .downcast_ref()
            .unwrap();
        assert_eq!(dev.service, "Otter Mail (Dev) Safe Storage");
        assert_eq!(release.service, "Otter Mail Safe Storage");
        assert_ne!(dev.account, release.account);
    }

    #[test]
    fn migrates_legacy_passwords_and_reopens_them() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path(), true);
        let legacy = BTreeMap::from([(
            "imap-password:demo@example.test".to_string(),
            Sealer::plain().seal("a made-up password 🦦").unwrap(),
        )]);
        write_json(&paths.file("secrets.json"), &legacy).unwrap();
        let secrets = Secrets::load(&paths, std::sync::Arc::new(test_sealer())).unwrap();
        secrets.protect().unwrap();
        assert_eq!(
            secrets.get("imap-password:demo@example.test").as_deref(),
            Some("a made-up password 🦦")
        );
        let saved: BTreeMap<String, String> = read_json(&paths.file("secrets.json")).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&saved["imap-password:demo@example.test"])
            .unwrap();
        assert!(bytes.starts_with(PREFIX));
        assert!(!String::from_utf8_lossy(&bytes).contains("made-up password"));
        let reopened = Secrets::load(&paths, std::sync::Arc::new(test_sealer())).unwrap();
        assert_eq!(
            reopened.get("imap-password:demo@example.test"),
            secrets.get("imap-password:demo@example.test")
        );
    }

    #[test]
    fn denied_keychain_leaves_legacy_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path(), true);
        let legacy = BTreeMap::from([("demo".to_string(), Sealer::plain().seal("fake").unwrap())]);
        write_json(&paths.file("secrets.json"), &legacy).unwrap();
        let before = std::fs::read(paths.file("secrets.json")).unwrap();
        let sealer = test_sealer();
        sealer
            .keychain
            .as_ref()
            .unwrap()
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap()
            .set_error(keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            )));
        let secrets = Secrets::load(&paths, std::sync::Arc::new(sealer)).unwrap();
        assert!(secrets.protect().is_err());
        assert_eq!(std::fs::read(paths.file("secrets.json")).unwrap(), before);
    }

    #[test]
    fn missing_key_is_not_recreated_while_decrypting() {
        let entry =
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        let sealer = Sealer {
            keychain: Some(entry),
            key: Mutex::new(None),
        };
        let sealed = test_sealer().seal("fake").unwrap();
        assert!(sealer.unseal(&sealed).is_err());
        assert!(matches!(
            sealer.keychain.as_ref().unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn corrupt_credentials_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path(), true);
        std::fs::write(paths.file("secrets.json"), b"{invalid").unwrap();
        assert!(Secrets::load(&paths, std::sync::Arc::new(test_sealer())).is_err());
        assert_eq!(
            std::fs::read(paths.file("secrets.json")).unwrap(),
            b"{invalid"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "writes a temporary test item to the macOS login Keychain"]
    fn apple_keychain_persists_across_reopen() {
        let service = format!("Otter Mail GPUI Test {}", uuid::Uuid::new_v4());
        let account = "temporary encryption key";
        let entry = || {
            keyring::Entry::new_with_credential(Box::new(
                keyring::macos::MacCredential::new_with_target(None, &service, account).unwrap(),
            ))
        };
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let cleanup = Cleanup(entry());
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path(), true);
        let sealer = std::sync::Arc::new(Sealer {
            keychain: Some(entry()),
            key: Mutex::new(None),
        });
        let secrets = Secrets::load(&paths, sealer).unwrap();
        secrets
            .set("temporary-test-password", Some("made-up password 🦦"))
            .unwrap();
        drop(secrets);
        let sealer = std::sync::Arc::new(Sealer {
            keychain: Some(entry()),
            key: Mutex::new(None),
        });
        let reopened = Secrets::load(&paths, sealer).unwrap();
        assert_eq!(
            reopened.get("temporary-test-password").as_deref(),
            Some("made-up password 🦦")
        );
        let saved: BTreeMap<String, String> = read_json(&paths.file("secrets.json")).unwrap();
        assert!(
            base64::engine::general_purpose::STANDARD
                .decode(&saved["temporary-test-password"])
                .unwrap()
                .starts_with(PREFIX)
        );
        cleanup.0.delete_credential().unwrap();
    }
}
