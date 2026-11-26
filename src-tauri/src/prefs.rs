use serde::{Deserialize, Serialize};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

pub const DEFAULT_PORT: u16 = 4318;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowPrefs {
    pub target_monitor_device: Option<String>,
    pub pin_across_desktops: bool,
    pub cover_taskbar: bool,
    pub always_on_top: bool,
    pub autostart: bool,
    pub server_port: u16,
}

impl Default for WindowPrefs {
    fn default() -> Self {
        Self {
            target_monitor_device: None,
            pin_across_desktops: true,
            cover_taskbar: true,
            always_on_top: false,
            autostart: false,
            server_port: DEFAULT_PORT,
        }
    }
}

impl WindowPrefs {
    pub fn path() -> io::Result<PathBuf> {
        let home = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        env::var_os(home)
            .map(|home| PathBuf::from(home).join(".orrery").join("window.json"))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{home} is unset")))
    }

    pub fn load(path: &Path) -> io::Result<Self> {
        let bytes = match fs::read(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            result => result?,
        };
        let prefs: Self = serde_json::from_slice(&bytes)?;
        if prefs.server_port == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "server_port must be 1–65535",
            ));
        }
        Ok(prefs)
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        let directory = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "missing preferences directory")
        })?;
        fs::create_dir_all(directory)?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut file, self)?;
        file.as_file().sync_all()?;
        file.persist(path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_and_partial_prefs_use_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.json");
        let defaults = WindowPrefs::load(&path).unwrap();
        assert!(defaults.pin_across_desktops && defaults.cover_taskbar);
        assert!(!defaults.always_on_top && !defaults.autostart);
        assert_eq!(defaults.target_monitor_device, None);
        assert_eq!(defaults.server_port, 4318);
        fs::write(&path, r#"{"always_on_top":true}"#).unwrap();
        assert_eq!(
            WindowPrefs::load(&path).unwrap(),
            WindowPrefs {
                always_on_top: true,
                ..defaults
            }
        );
    }

    #[test]
    fn creates_directory_and_atomically_replaces_existing_prefs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".orrery/window.json");
        WindowPrefs::default().save(&path).unwrap();
        let prefs = WindowPrefs {
            target_monitor_device: Some(r"\\.\DISPLAY2".into()),
            pin_across_desktops: false,
            cover_taskbar: false,
            always_on_top: true,
            autostart: true,
            server_port: 56321,
        };
        prefs.save(&path).unwrap();
        assert_eq!(WindowPrefs::load(&path).unwrap(), prefs);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn rejects_invalid_json_and_unconnectable_port() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.json");
        for contents in ["{", r#"{"server_port":0}"#] {
            fs::write(&path, contents).unwrap();
            assert!(WindowPrefs::load(&path).is_err());
        }
    }
}
