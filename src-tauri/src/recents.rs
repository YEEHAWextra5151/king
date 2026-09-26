//! Open Recent (persisted, mirrored into the Dock menu via
//! NSDocumentController) and per-file reading positions.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_store::{Store, StoreExt};

use crate::paths;
use crate::settings::{folio_data_dir, ViewMode};

const MAX_RECENTS: usize = 15;
const MAX_POSITIONS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    pub name: String,
    pub is_folder: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub path: String,
    /// Fractional source line at the top of the viewport.
    pub line: f64,
    pub view_mode: Option<ViewMode>,
}

#[derive(Default)]
pub struct Recents {
    items: RwLock<Vec<RecentItem>>,
    positions: RwLock<Vec<ReadingPosition>>,
    store: RwLock<Option<Arc<Store<Wry>>>>,
}

impl Recents {
    pub fn load(&self, app: &AppHandle) {
        let path = folio_data_dir(app).join("recents.json");
        match app.store(path) {
            Ok(store) => {
                if let Some(v) = store.get("recents") {
                    if let Ok(items) = serde_json::from_value::<Vec<RecentItem>>(v) {
                        *self.items.write() = items;
                    }
                }
                if let Some(v) = store.get("positions") {
                    if let Ok(p) = serde_json::from_value::<Vec<ReadingPosition>>(v) {
                        *self.positions.write() = p;
                    }
                }
                *self.store.write() = Some(store);
            }
            Err(err) => log::error!("could not open recents store: {err}"),
        }
    }

    pub fn items(&self) -> Vec<RecentItem> {
        self.items.read().clone()
    }

    pub fn add(&self, path: &Path) {
        let path_str = paths::to_string(path);
        let item = RecentItem {
            name: paths::display_name(path),
            is_folder: path.is_dir(),
            path: path_str.clone(),
        };
        {
            let mut items = self.items.write();
            items.retain(|i| i.path != path_str);
            items.insert(0, item);
            items.truncate(MAX_RECENTS);
        }
        self.persist();
    }

    pub fn clear(&self) {
        self.items.write().clear();
        self.persist();
    }

    pub fn position(&self, path: &str) -> Option<ReadingPosition> {
        self.positions.read().iter().find(|p| p.path == path).cloned()
    }

    pub fn save_position(&self, pos: ReadingPosition) {
        {
            let mut positions = self.positions.write();
            positions.retain(|p| p.path != pos.path);
            positions.insert(0, pos);
            positions.truncate(MAX_POSITIONS);
        }
        self.persist();
    }

    fn persist(&self) {
        if let Some(store) = self.store.read().as_ref() {
            store.set("recents", serde_json::to_value(&*self.items.read()).unwrap_or_default());
            store.set(
                "positions",
                serde_json::to_value(&*self.positions.read()).unwrap_or_default(),
            );
            if let Err(err) = store.save() {
                log::warn!("could not save recents: {err}");
            }
        }
    }
}

/// Adds a document or folder to Open Recent and the Dock menu.
pub fn note(app: &AppHandle, path: &Path) {
    let state = app.state::<Recents>();
    state.add(path);
    crate::macos::note_recent_document(app, path);
    changed(app);
}

pub fn clear(app: &AppHandle) {
    app.state::<Recents>().clear();
    crate::macos::clear_recent_documents(app);
    changed(app);
}

fn changed(app: &AppHandle) {
    let items = app.state::<Recents>().items();
    crate::menu::rebuild_recents(app, &items);
    let existing: Vec<&RecentItem> = items.iter().filter(|i| Path::new(&i.path).exists()).collect();
    let _ = app.emit("recents-changed", &existing);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recents_are_deduped_and_capped() {
        let r = Recents::default();
        for i in 0..20 {
            r.add(Path::new(&format!("/tmp/folio-{i}.md")));
        }
        r.add(Path::new("/tmp/folio-3.md"));
        let items = r.items();
        assert_eq!(items.len(), MAX_RECENTS);
        assert_eq!(items[0].path, "/tmp/folio-3.md");
        assert_eq!(items.iter().filter(|i| i.path == "/tmp/folio-3.md").count(), 1);
    }

    #[test]
    fn positions_replace_previous_entry() {
        let r = Recents::default();
        r.save_position(ReadingPosition {
            path: "/a.md".into(),
            line: 10.0,
            view_mode: None,
        });
        r.save_position(ReadingPosition {
            path: "/a.md".into(),
            line: 42.5,
            view_mode: Some(ViewMode::Code),
        });
        let p = r.position("/a.md").unwrap();
        assert_eq!(p.line, 42.5);
        assert_eq!(p.view_mode, Some(ViewMode::Code));
    }
}
