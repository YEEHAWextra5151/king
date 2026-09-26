//! The authoritative map of windows → tabs. Each window's frontend reports a
//! snapshot whenever its tabs change; Rust uses it for cross-window dedupe,
//! menu state, session saving, and Merge All Windows.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

use crate::paths;
use crate::settings::ViewMode;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TabSnapshot {
    pub id: String,
    pub path: Option<String>,
    pub title: String,
    pub is_stdin: bool,
    pub view_mode: ViewMode,
    /// Everything else (scroll anchor, split ratio, history…) is carried
    /// opaquely so session restore and tab moves preserve it.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SidebarState {
    pub visible: bool,
    pub width: f64,
    /// "outline" or "files".
    pub pane: String,
}

impl Default for SidebarState {
    fn default() -> Self {
        SidebarState {
            visible: false,
            width: 240.0,
            pane: "outline".into(),
        }
    }
}

/// What the menu bar needs to know about the focused window.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuState {
    pub has_document: bool,
    pub is_markdown: bool,
    pub view_mode: ViewMode,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub has_headings: bool,
    pub has_closed_tabs: bool,
    pub tab_count: usize,
    pub sidebar_visible: bool,
    pub sidebar_pane: String,
    pub has_folder: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowSnapshot {
    pub tabs: Vec<TabSnapshot>,
    pub active_tab_id: Option<String>,
    pub folder: Option<String>,
    pub sidebar: SidebarState,
    pub menu: MenuState,
}

impl WindowSnapshot {
    pub fn active_tab(&self) -> Option<&TabSnapshot> {
        let id = self.active_tab_id.as_deref()?;
        self.tabs.iter().find(|t| t.id == id)
    }
}

#[derive(Debug, Clone)]
pub struct WindowEntry {
    pub label: String,
    pub snapshot: WindowSnapshot,
}

#[derive(Default)]
pub struct Registry {
    windows: RwLock<Vec<WindowEntry>>,
    /// Document window labels, most recently focused first.
    focus_order: RwLock<Vec<String>>,
}

impl Registry {
    pub fn add_window(&self, label: &str) {
        let mut windows = self.windows.write();
        if !windows.iter().any(|w| w.label == label) {
            windows.push(WindowEntry {
                label: label.to_string(),
                snapshot: WindowSnapshot::default(),
            });
        }
        drop(windows);
        self.note_focus(label);
    }

    pub fn remove_window(&self, label: &str) -> Option<WindowSnapshot> {
        self.focus_order.write().retain(|l| l != label);
        let mut windows = self.windows.write();
        let idx = windows.iter().position(|w| w.label == label)?;
        Some(windows.remove(idx).snapshot)
    }

    pub fn update(&self, label: &str, snapshot: WindowSnapshot) {
        let mut windows = self.windows.write();
        match windows.iter_mut().find(|w| w.label == label) {
            Some(entry) => entry.snapshot = snapshot,
            None => windows.push(WindowEntry {
                label: label.to_string(),
                snapshot,
            }),
        }
    }

    pub fn note_focus(&self, label: &str) {
        let mut order = self.focus_order.write();
        order.retain(|l| l != label);
        order.insert(0, label.to_string());
    }

    /// The most recently focused document window that still exists.
    pub fn frontmost(&self) -> Option<String> {
        let windows = self.windows.read();
        self.focus_order
            .read()
            .iter()
            .find(|l| windows.iter().any(|w| &w.label == *l))
            .cloned()
    }

    pub fn snapshot(&self, label: &str) -> Option<WindowSnapshot> {
        self.windows
            .read()
            .iter()
            .find(|w| w.label == label)
            .map(|w| w.snapshot.clone())
    }

    /// All windows, most recently focused first.
    pub fn all(&self) -> Vec<WindowEntry> {
        let windows = self.windows.read();
        let order = self.focus_order.read();
        let mut out: Vec<WindowEntry> = order
            .iter()
            .filter_map(|l| windows.iter().find(|w| &w.label == l).cloned())
            .collect();
        for w in windows.iter() {
            if !out.iter().any(|o| o.label == w.label) {
                out.push(w.clone());
            }
        }
        out
    }

    /// Finds the window and tab showing `path` (compared canonically).
    pub fn find_path(&self, path: &Path) -> Option<(String, String)> {
        let wanted = paths::best_effort_canonical(path);
        let windows = self.windows.read();
        for label in self.focus_order.read().iter() {
            if let Some(w) = windows.iter().find(|w| &w.label == label) {
                if let Some(tab) = w.snapshot.tabs.iter().find(|t| {
                    t.path
                        .as_deref()
                        .is_some_and(|p| paths::best_effort_canonical(Path::new(p)) == wanted)
                }) {
                    return Some((w.label.clone(), tab.id.clone()));
                }
            }
        }
        None
    }

    pub fn window_with_folder(&self, folder: &Path) -> Option<String> {
        let wanted = paths::best_effort_canonical(folder);
        self.windows
            .read()
            .iter()
            .find(|w| {
                w.snapshot
                    .folder
                    .as_deref()
                    .is_some_and(|f| paths::best_effort_canonical(Path::new(f)) == wanted)
            })
            .map(|w| w.label.clone())
    }

    /// Every file path open in any tab (for the watcher).
    pub fn open_paths(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .windows
            .read()
            .iter()
            .flat_map(|w| w.snapshot.tabs.iter().filter_map(|t| t.path.clone()))
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Labels of windows that currently show `path`.
    pub fn windows_showing(&self, path: &str) -> Vec<String> {
        self.windows
            .read()
            .iter()
            .filter(|w| w.snapshot.tabs.iter().any(|t| t.path.as_deref() == Some(path)))
            .map(|w| w.label.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str, path: &str) -> TabSnapshot {
        TabSnapshot {
            id: id.into(),
            path: Some(path.into()),
            title: path.into(),
            ..Default::default()
        }
    }

    #[test]
    fn dedupe_prefers_recent_windows() {
        let r = Registry::default();
        r.add_window("doc-1");
        r.add_window("doc-2");
        let snap = |t: TabSnapshot| WindowSnapshot {
            tabs: vec![t],
            ..Default::default()
        };
        r.update("doc-1", snap(tab("a", "/tmp/folio-x.md")));
        r.update("doc-2", snap(tab("b", "/tmp/folio-x.md")));
        r.note_focus("doc-1");
        assert_eq!(
            r.find_path(Path::new("/tmp/folio-x.md")),
            Some(("doc-1".into(), "a".into()))
        );
        assert_eq!(r.frontmost().as_deref(), Some("doc-1"));
        r.remove_window("doc-1");
        assert_eq!(r.frontmost().as_deref(), Some("doc-2"));
        assert_eq!(r.windows_showing("/tmp/folio-x.md"), vec!["doc-2".to_string()]);
    }

    #[test]
    fn snapshot_keeps_unknown_tab_fields() {
        let json = serde_json::json!({
            "tabs": [{"id": "t1", "path": "/a.md", "title": "a.md", "viewMode": "split",
                      "splitRatio": 0.4, "history": {"back": [], "forward": []}}],
            "activeTabId": "t1"
        });
        let snap: WindowSnapshot = serde_json::from_value(json).unwrap();
        let t = snap.active_tab().unwrap();
        assert_eq!(t.view_mode, ViewMode::Split);
        assert_eq!(t.rest["splitRatio"], 0.4);
        let back = serde_json::to_value(&snap).unwrap();
        assert_eq!(back["tabs"][0]["history"]["back"], serde_json::json!([]));
    }
}
