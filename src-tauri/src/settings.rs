//! Typed settings, persisted with tauri-plugin-store and broadcast to every
//! window on change. Rust owns the values; the frontend mirrors them.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_store::{Store, StoreExt};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ViewMode {
    #[default]
    Preview,
    Code,
    Split,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum OpenFilesIn {
    #[default]
    Tabs,
    Windows,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SessionRestore {
    #[default]
    System,
    Always,
    Never,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum FontFamily {
    #[default]
    Serif,
    Sans,
    Mono,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ReadingWidth {
    Narrow,
    #[default]
    Medium,
    Wide,
    Full,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum FrontMatterDisplay {
    #[default]
    Hidden,
    Card,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // General
    pub open_files_in: OpenFilesIn,
    pub session_restore: SessionRestore,
    pub default_view_mode: ViewMode,
    pub remember_mode_per_file: bool,
    // Appearance
    /// "claude", "github", "paper", or "custom:<file stem>".
    pub theme: String,
    pub appearance: Appearance,
    // Reading
    pub font_family: FontFamily,
    pub font_size: f64,
    pub line_height: f64,
    pub reading_width: ReadingWidth,
    pub front_matter: FrontMatterDisplay,
    pub highlight_changes: bool,
    pub status_bar: bool,
    /// ⌘+ / ⌘− multiplier on the reading font size.
    pub text_zoom: f64,
    pub soft_wrap: bool,
    // Advanced
    pub remote_images: bool,
    /// "auto" or an application bundle identifier.
    pub editor: String,
    // Internal
    pub default_app_banner_shown: bool,
    pub last_settings_pane: String,
    pub last_window_size: Option<(f64, f64)>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            open_files_in: OpenFilesIn::Tabs,
            session_restore: SessionRestore::System,
            default_view_mode: ViewMode::Preview,
            remember_mode_per_file: false,
            theme: "claude".into(),
            appearance: Appearance::System,
            font_family: FontFamily::Serif,
            font_size: 17.0,
            line_height: 1.65,
            reading_width: ReadingWidth::Medium,
            front_matter: FrontMatterDisplay::Hidden,
            highlight_changes: true,
            status_bar: false,
            text_zoom: 1.0,
            soft_wrap: true,
            remote_images: true,
            editor: "auto".into(),
            default_app_banner_shown: false,
            last_settings_pane: "general".into(),
            last_window_size: None,
        }
    }
}

impl Settings {
    /// Clamps values that a hand-edited settings file could push out of range.
    pub fn sanitized(mut self) -> Self {
        self.font_size = self.font_size.clamp(11.0, 32.0);
        self.line_height = self.line_height.clamp(1.2, 2.2);
        self.text_zoom = self.text_zoom.clamp(0.5, 3.0);
        if self.theme.trim().is_empty() {
            self.theme = "claude".into();
        }
        self
    }
}

const STORE_KEY: &str = "settings";

/// Text zoom steps, like Safari's.
const ZOOM_STEPS: &[f64] = &[0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

/// The next zoom step up (`direction > 0`) or down from `current`.
pub fn zoom_step(current: f64, direction: i32) -> f64 {
    if direction > 0 {
        ZOOM_STEPS
            .iter()
            .copied()
            .find(|z| *z > current + 1e-6)
            .unwrap_or(*ZOOM_STEPS.last().unwrap())
    } else {
        ZOOM_STEPS
            .iter()
            .rev()
            .copied()
            .find(|z| *z < current - 1e-6)
            .unwrap_or(ZOOM_STEPS[0])
    }
}

pub struct SettingsState {
    current: RwLock<Settings>,
    store: RwLock<Option<Arc<Store<Wry>>>>,
}

impl Default for SettingsState {
    fn default() -> Self {
        SettingsState {
            current: RwLock::new(Settings::default()),
            store: RwLock::new(None),
        }
    }
}

/// `~/Library/Application Support/Folio` (or the platform equivalent).
pub fn folio_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .data_dir()
        .map(|d| d.join("Folio"))
        .unwrap_or_else(|_| std::env::temp_dir().join("Folio"))
}

impl SettingsState {
    pub fn load(&self, app: &AppHandle) {
        let path = folio_data_dir(app).join("settings.json");
        match app.store(path) {
            Ok(store) => {
                if let Some(value) = store.get(STORE_KEY) {
                    match serde_json::from_value::<Settings>(value) {
                        Ok(s) => *self.current.write() = s.sanitized(),
                        Err(err) => log::warn!("settings file unreadable, using defaults: {err}"),
                    }
                }
                *self.store.write() = Some(store);
            }
            Err(err) => log::error!("could not open settings store: {err}"),
        }
    }

    pub fn get(&self) -> Settings {
        self.current.read().clone()
    }

    /// Merges a partial JSON object into the settings, persists, and returns
    /// the new value. Unknown keys and invalid values are ignored.
    pub fn update(&self, patch: &Value) -> Settings {
        let mut merged = serde_json::to_value(self.get()).unwrap_or(Value::Null);
        if let (Some(target), Some(source)) = (merged.as_object_mut(), patch.as_object()) {
            for (k, v) in source {
                if target.contains_key(k) {
                    let previous = target.insert(k.clone(), v.clone());
                    // Reject a value that doesn't deserialize, keeping the old one.
                    let candidate = Value::Object(target.clone());
                    if serde_json::from_value::<Settings>(candidate).is_err() {
                        if let Some(prev) = previous {
                            target.insert(k.clone(), prev);
                        }
                    }
                }
            }
        }
        let next = serde_json::from_value::<Settings>(merged)
            .unwrap_or_default()
            .sanitized();
        *self.current.write() = next.clone();
        self.persist();
        next
    }

    pub fn reset(&self) -> Settings {
        // Keep internal bookkeeping so a reset doesn't re-show the banner.
        let banner = self.current.read().default_app_banner_shown;
        let next = Settings {
            default_app_banner_shown: banner,
            ..Settings::default()
        };
        *self.current.write() = next.clone();
        self.persist();
        next
    }

    pub fn set_internal(&self, f: impl FnOnce(&mut Settings)) {
        f(&mut self.current.write());
        self.persist();
    }

    /// Updates without writing to disk (for values that change rapidly,
    /// like the last window size); saved by `persist_now` at exit.
    pub fn set_in_memory(&self, f: impl FnOnce(&mut Settings)) {
        f(&mut self.current.write());
    }

    pub fn persist_now(&self) {
        self.persist();
    }

    fn persist(&self) {
        if let Some(store) = self.store.read().as_ref() {
            if let Ok(v) = serde_json::to_value(&*self.current.read()) {
                store.set(STORE_KEY, v);
                if let Err(err) = store.save() {
                    log::error!("could not save settings: {err}");
                }
            }
        }
    }
}

/// Applies a settings change everywhere: native window chrome, menus, and
/// every webview.
pub fn broadcast(app: &AppHandle, settings: &Settings) {
    crate::windows::apply_appearance_to_all(app, settings);
    crate::menu::sync_settings(app, settings);
    let _ = app.emit("settings-changed", settings);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_round_trip_as_camel_case() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["defaultViewMode"], "preview");
        assert_eq!(v["theme"], "claude");
        assert_eq!(v["readingWidth"], "medium");
        let back: Settings = serde_json::from_value(v).unwrap();
        assert_eq!(back, Settings::default());
    }

    #[test]
    fn partial_files_fill_defaults() {
        let s: Settings = serde_json::from_value(json!({"fontSize": 20})).unwrap();
        assert_eq!(s.font_size, 20.0);
        assert_eq!(s.theme, "claude");
    }

    #[test]
    fn zoom_steps() {
        assert_eq!(zoom_step(1.0, 1), 1.1);
        assert_eq!(zoom_step(1.0, -1), 0.9);
        assert_eq!(zoom_step(3.0, 1), 3.0);
        assert_eq!(zoom_step(0.5, -1), 0.5);
        assert_eq!(zoom_step(1.05, 1), 1.1);
    }

    #[test]
    fn update_ignores_invalid_values() {
        let state = SettingsState::default();
        let s = state.update(&json!({"appearance": "dark", "fontSize": "huge", "bogus": 1}));
        assert_eq!(s.appearance, Appearance::Dark);
        assert_eq!(s.font_size, 17.0);
        let s = state.update(&json!({"fontSize": 99}));
        assert_eq!(s.font_size, 32.0);
    }
}
