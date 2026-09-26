//! Queues for open requests.
//!
//! * The cold queue holds paths that arrive before `setup` has run. On a cold
//!   launch AppKit calls `application:openURLs:` before
//!   `applicationDidFinishLaunching:`, so `RunEvent::Opened` fires before
//!   any window (or frontend) exists.
//! * Each window has a pending queue that its frontend drains on mount and
//!   whenever it receives a `documents-opened` signal. Pushing before
//!   signalling means a request can't be lost if the signal races the mount.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::registry::SidebarState;
use crate::settings::ViewMode;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Markdown,
    Text,
    Folder,
    /// Missing or unreadable: opens a tab with a calm error state.
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub path: String,
    pub kind: TargetKind,
    pub view: Option<ViewMode>,
    pub line: Option<u32>,
    pub is_stdin: bool,
    /// Tab-bar position for drops onto the tab bar.
    pub insert_at: Option<usize>,
    /// Whether this tab should become active.
    pub activate: bool,
    /// For folder requests: the README/index to show.
    pub readme: Option<String>,
    /// A complete tab state (moved tabs, Merge All Windows).
    pub tab: Option<Value>,
}

impl OpenRequest {
    pub fn new(path: String, kind: TargetKind) -> Self {
        OpenRequest {
            path,
            kind,
            view: None,
            line: None,
            is_stdin: false,
            insert_at: None,
            activate: true,
            readme: None,
            tab: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OpenSource {
    #[default]
    Finder,
    Cli,
    Panel,
    Drop,
    Recent,
    Session,
}

#[derive(Debug, Clone, Default)]
pub struct OpenOptions {
    pub view: Option<ViewMode>,
    pub line: Option<u32>,
    pub new_window: bool,
    pub target_window: Option<String>,
    pub insert_at: Option<usize>,
    pub stdin: bool,
    pub source: OpenSource,
}

/// Initial state for a newly created document window.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInit {
    pub tabs: Vec<Value>,
    pub active_tab_id: Option<String>,
    pub folder: Option<String>,
    pub sidebar: Option<SidebarState>,
    pub notices: Vec<String>,
    pub show_default_app_banner: bool,
}

#[derive(Default)]
pub struct OpenQueue {
    ready: AtomicBool,
    cold: Mutex<Vec<(Vec<PathBuf>, OpenOptions)>>,
    per_window: Mutex<HashMap<String, Vec<OpenRequest>>>,
    inits: Mutex<HashMap<String, WindowInit>>,
}

impl OpenQueue {
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn set_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn push_cold(&self, paths: Vec<PathBuf>, opts: OpenOptions) {
        self.cold.lock().push((paths, opts));
    }

    /// Paths waiting in the cold queue (without removing them).
    pub fn cold_paths(&self) -> Vec<PathBuf> {
        self.cold
            .lock()
            .iter()
            .flat_map(|(paths, _)| paths.clone())
            .collect()
    }

    pub fn take_cold(&self) -> Vec<(Vec<PathBuf>, OpenOptions)> {
        std::mem::take(&mut *self.cold.lock())
    }

    pub fn push_for_window(&self, label: &str, requests: Vec<OpenRequest>) {
        self.per_window
            .lock()
            .entry(label.to_string())
            .or_default()
            .extend(requests);
    }

    pub fn take_for_window(&self, label: &str) -> Vec<OpenRequest> {
        self.per_window.lock().remove(label).unwrap_or_default()
    }

    pub fn set_init(&self, label: &str, init: WindowInit) {
        self.inits.lock().insert(label.to_string(), init);
    }

    pub fn take_init(&self, label: &str) -> WindowInit {
        self.inits.lock().remove(label).unwrap_or_default()
    }

    pub fn forget_window(&self, label: &str) {
        self.per_window.lock().remove(label);
        self.inits.lock().remove(label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_window_queue_drains_once() {
        let q = OpenQueue::default();
        q.push_for_window("doc-1", vec![OpenRequest::new("/a.md".into(), TargetKind::Markdown)]);
        q.push_for_window("doc-1", vec![OpenRequest::new("/b.md".into(), TargetKind::Markdown)]);
        let got = q.take_for_window("doc-1");
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].path, "/b.md");
        assert!(q.take_for_window("doc-1").is_empty());
    }

    #[test]
    fn cold_queue_holds_until_ready() {
        let q = OpenQueue::default();
        assert!(!q.is_ready());
        q.push_cold(vec![PathBuf::from("/a.md")], OpenOptions::default());
        q.set_ready();
        assert_eq!(q.take_cold().len(), 1);
        assert!(q.take_cold().is_empty());
    }

    #[test]
    fn requests_serialize_camel_case() {
        let mut r = OpenRequest::new("/a.md".into(), TargetKind::Folder);
        r.is_stdin = true;
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["kind"], "folder");
        assert_eq!(v["isStdin"], true);
        assert_eq!(v["insertAt"], serde_json::Value::Null);
    }
}
