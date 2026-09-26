//! Session save/restore: windows (with frames), their tabs and per-tab view
//! state. Restoring follows the setting: System (macOS's "Close windows when
//! quitting an application", i.e. `NSQuitAlwaysKeepsWindows`), Always, or
//! Never. Missing files are skipped with a quiet notice.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::{Store, StoreExt};

use crate::access::Access;
use crate::open_queue::WindowInit;
use crate::paths;
use crate::registry::{Registry, WindowSnapshot};
use crate::settings::{folio_data_dir, SessionRestore, SettingsState};
use crate::windows::{self, Frame};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionWindow {
    pub frame: Option<Frame>,
    pub snapshot: WindowSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub windows: Vec<SessionWindow>,
}

#[derive(Default)]
pub struct SessionState {
    dirty: AtomicBool,
    /// Set once the user quits, so windows closing during shutdown don't
    /// erase the session.
    quitting: AtomicBool,
    store: Mutex<Option<Arc<Store<Wry>>>>,
}

impl SessionState {
    pub fn mark_dirty(&self) {
        if !self.quitting.load(Ordering::SeqCst) {
            self.dirty.store(true, Ordering::SeqCst);
        }
    }

    pub fn set_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

pub fn should_restore(policy: SessionRestore) -> bool {
    match policy {
        SessionRestore::Always => true,
        SessionRestore::Never => false,
        SessionRestore::System => crate::macos::quit_always_keeps_windows(),
    }
}

fn store(app: &AppHandle) -> Option<Arc<Store<Wry>>> {
    let state = app.state::<SessionState>();
    let mut guard = state.store.lock();
    if guard.is_none() {
        match app.store(folio_data_dir(app).join("session.json")) {
            Ok(s) => *guard = Some(s),
            Err(err) => log::error!("could not open session store: {err}"),
        }
    }
    guard.clone()
}

pub fn capture(app: &AppHandle) -> Session {
    let registry = app.state::<Registry>();
    let windows = registry
        .all()
        .into_iter()
        .filter(|w| w.label.starts_with("doc-"))
        .map(|w| SessionWindow {
            frame: app
                .get_webview_window(&w.label)
                .and_then(|win| windows::frame_of(&win)),
            snapshot: w.snapshot,
        })
        // Frontmost window last, so it's created last and ends up on top.
        .rev()
        .collect();
    Session { windows }
}

pub fn save_now(app: &AppHandle) {
    let session = capture(app);
    if let Some(store) = store(app) {
        store.set("session", serde_json::to_value(&session).unwrap_or(Value::Null));
        if let Err(err) = store.save() {
            log::warn!("could not save session: {err}");
        }
    }
    app.state::<SessionState>().dirty.store(false, Ordering::SeqCst);
}

/// Saves the session at most once a second while anything changes.
pub fn start_autosave(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = app.state::<SessionState>();
        if state.is_quitting() {
            break;
        }
        if state.dirty.swap(false, Ordering::SeqCst) {
            save_now(&app);
        }
    });
}

fn load(app: &AppHandle) -> Session {
    store(app)
        .and_then(|s| s.get("session"))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Filters a saved window's tabs to files that still exist.
/// Returns the kept tabs (as JSON) and how many were dropped.
pub fn surviving_tabs(snapshot: &WindowSnapshot) -> (Vec<Value>, usize) {
    let mut kept = Vec::new();
    let mut missing = 0;
    for tab in &snapshot.tabs {
        match tab.path.as_deref() {
            // Standard Input temp files are deleted on launch.
            Some(p) if tab.is_stdin || paths::is_stdin_temp(Path::new(p)) => {}
            Some(p) if Path::new(p).exists() => {
                kept.push(serde_json::to_value(tab).unwrap_or(Value::Null))
            }
            Some(_) => missing += 1,
            None => {}
        }
    }
    (kept, missing)
}

/// Restores the previous session. Returns the number of windows created.
pub fn restore(app: &AppHandle) -> usize {
    let settings = app.state::<SettingsState>().get();
    if !should_restore(settings.session_restore) {
        return 0;
    }
    let session = load(app);
    let access = app.state::<Access>();
    let mut created = 0;
    let mut missing_total = 0;
    let count = session.windows.len();
    for (index, window) in session.windows.into_iter().enumerate() {
        let (tabs, missing) = surviving_tabs(&window.snapshot);
        missing_total += missing;
        let folder = window
            .snapshot
            .folder
            .clone()
            .filter(|f| Path::new(f).is_dir());
        if tabs.is_empty() && folder.is_none() {
            continue;
        }
        for tab in &tabs {
            if let Some(p) = tab.get("path").and_then(Value::as_str) {
                access.grant_file(&PathBuf::from(p));
            }
        }
        if let Some(f) = &folder {
            access.grant_dir(Path::new(f));
        }
        let active = window
            .snapshot
            .active_tab_id
            .clone()
            .filter(|id| tabs.iter().any(|t| t.get("id").and_then(Value::as_str) == Some(id)));
        let is_last = index + 1 == count;
        let notices = if is_last && missing_total > 0 {
            vec![match missing_total {
                1 => "1 file from your last session couldn't be found.".to_string(),
                n => format!("{n} files from your last session couldn't be found."),
            }]
        } else {
            Vec::new()
        };
        let init = WindowInit {
            tabs,
            active_tab_id: active,
            folder,
            sidebar: Some(window.snapshot.sidebar.clone()),
            notices,
            show_default_app_banner: false,
        };
        if windows::create_document_window_at(app, init, Vec::new(), window.frame).is_some() {
            created += 1;
        }
    }
    created
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::TabSnapshot;

    #[test]
    fn missing_and_stdin_tabs_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("here.md");
        std::fs::write(&present, "x").unwrap();
        let tab = |id: &str, p: &Path, stdin: bool| TabSnapshot {
            id: id.into(),
            path: Some(p.to_string_lossy().into_owned()),
            is_stdin: stdin,
            ..Default::default()
        };
        let snap = WindowSnapshot {
            tabs: vec![
                tab("a", &present, false),
                tab("b", &dir.path().join("gone.md"), false),
                tab("c", &present, true),
            ],
            ..Default::default()
        };
        let (kept, missing) = surviving_tabs(&snap);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["id"], "a");
        assert_eq!(missing, 1);
    }

    #[test]
    fn policy() {
        assert!(should_restore(SessionRestore::Always));
        assert!(!should_restore(SessionRestore::Never));
    }
}
