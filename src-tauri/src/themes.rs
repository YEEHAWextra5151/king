//! User themes: `~/Library/Application Support/Folio/themes/*.css`,
//! hot-reloaded into every window.

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{folio_data_dir, SettingsState};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    /// File stem; selected as `custom:<name>`.
    pub name: String,
    pub css: String,
}

#[derive(Default)]
pub struct ThemeWatcher(Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>);

pub fn themes_dir(app: &AppHandle) -> PathBuf {
    folio_data_dir(app).join("themes")
}

const MAX_THEME_BYTES: u64 = 512 * 1024;

pub fn list(app: &AppHandle) -> Vec<CustomTheme> {
    let dir = themes_dir(app);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut themes: Vec<CustomTheme> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|e| e.eq_ignore_ascii_case("css"))
                && std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() <= MAX_THEME_BYTES)
        })
        .filter_map(|p| {
            let name = p.file_stem()?.to_string_lossy().into_owned();
            let css = std::fs::read_to_string(&p).ok()?;
            Some(CustomTheme { name, css })
        })
        .collect();
    themes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    themes
}

/// The CSS of the active theme when it's a custom one (for the boot script,
/// so custom themes also paint correctly on the first frame).
pub fn active_theme_css(app: &AppHandle, theme: &str) -> Option<String> {
    let name = theme.strip_prefix("custom:")?;
    list(app).into_iter().find(|t| t.name == name).map(|t| t.css)
}

pub fn names(themes: &[CustomTheme]) -> Vec<String> {
    themes.iter().map(|t| t.name.clone()).collect()
}

fn changed(app: &AppHandle) {
    let themes = list(app);
    let current = app.state::<SettingsState>().get().theme;
    crate::menu::rebuild_themes(app, &names(&themes), &current);
    let _ = app.emit("themes-changed", &themes);
}

pub fn start(app: &AppHandle) {
    let dir = themes_dir(app);
    if let Err(err) = std::fs::create_dir_all(&dir) {
        log::warn!("could not create themes folder: {err}");
    }
    let handle = app.clone();
    match new_debouncer(
        Duration::from_millis(150),
        None,
        move |res: DebounceEventResult| {
            if res.is_ok() {
                changed(&handle);
            }
        },
    ) {
        Ok(mut debouncer) => {
            if let Err(err) = debouncer.watch(&dir, RecursiveMode::NonRecursive) {
                log::warn!("could not watch themes folder: {err}");
            }
            *app.state::<ThemeWatcher>().0.lock() = Some(debouncer);
        }
        Err(err) => log::warn!("themes watcher unavailable: {err}"),
    }
    let current = app.state::<SettingsState>().get().theme;
    crate::menu::rebuild_themes(app, &names(&list(app)), &current);
}

pub fn reveal_folder(app: &AppHandle) {
    let dir = themes_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    crate::commands::reveal_path(app, &dir);
}
