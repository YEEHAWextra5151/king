//! The native menu bar. Every command has a menu item with its shortcut;
//! enabled and checked state follow the focused window. Window and Help are
//! registered with NSApp so macOS manages the window list and Help search.

use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::image::Image;
use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuItem,
    PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::recents::RecentItem;
use crate::registry::{MenuState, Registry};
use crate::settings::{Appearance, ReadingWidth, Settings, SettingsState, ViewMode};

/// (id, label, accelerator) for plain command items. Labels that change with
/// state (Show/Hide Sidebar…) are updated in `apply_state`.
pub const ITEMS: &[(&str, &str, Option<&str>)] = &[
    // App
    ("settings", "Settings…", Some("CmdOrCtrl+Comma")),
    ("install_cli", "Install Command Line Tool…", None),
    // File
    ("new_window", "New Window", Some("CmdOrCtrl+N")),
    ("new_tab", "New Tab", Some("CmdOrCtrl+T")),
    ("open", "Open…", Some("CmdOrCtrl+O")),
    ("open_folder", "Open Folder…", Some("Alt+CmdOrCtrl+O")),
    ("open_quickly", "Open Quickly…", Some("Shift+CmdOrCtrl+O")),
    ("clear_recents", "Clear Menu", None),
    ("close_tab", "Close Tab", Some("CmdOrCtrl+W")),
    ("close_window", "Close Window", Some("Shift+CmdOrCtrl+W")),
    ("reopen_closed_tab", "Reopen Closed Tab", Some("Shift+CmdOrCtrl+T")),
    ("reload", "Reload", Some("CmdOrCtrl+R")),
    ("open_in_editor", "Open in Editor", Some("Shift+CmdOrCtrl+E")),
    ("reveal_in_finder", "Reveal in Finder", Some("Alt+CmdOrCtrl+R")),
    ("export_html", "HTML…", None),
    ("print", "Print…", Some("CmdOrCtrl+P")),
    // Edit
    ("copy_markdown", "Copy as Markdown", None),
    ("copy_html", "Copy as HTML", None),
    ("select_all", "Select All", Some("CmdOrCtrl+A")),
    ("find", "Find…", Some("CmdOrCtrl+F")),
    ("find_next", "Find Next", Some("CmdOrCtrl+G")),
    ("find_previous", "Find Previous", Some("Shift+CmdOrCtrl+G")),
    ("find_selection", "Use Selection for Find", Some("CmdOrCtrl+E")),
    // View
    ("toggle_code", "Show Code", Some("CmdOrCtrl+Slash")),
    ("toggle_split", "Show Split", Some("CmdOrCtrl+Backslash")),
    ("toggle_sidebar", "Show Sidebar", Some("Ctrl+CmdOrCtrl+S")),
    ("zoom_reset", "Actual Size", Some("CmdOrCtrl+0")),
    ("zoom_in", "Zoom In", Some("CmdOrCtrl+NumpadAdd")),
    ("zoom_out", "Zoom Out", Some("CmdOrCtrl+Minus")),
    ("open_themes_folder", "Open Themes Folder", None),
    // Go
    ("go_back", "Back", Some("CmdOrCtrl+BracketLeft")),
    ("go_forward", "Forward", Some("CmdOrCtrl+BracketRight")),
    ("next_heading", "Next Heading", Some("Alt+CmdOrCtrl+Down")),
    ("previous_heading", "Previous Heading", Some("Alt+CmdOrCtrl+Up")),
    // Window
    ("previous_tab", "Show Previous Tab", Some("Shift+CmdOrCtrl+BracketLeft")),
    ("next_tab", "Show Next Tab", Some("Shift+CmdOrCtrl+BracketRight")),
    ("move_tab_to_new_window", "Move Tab to New Window", None),
    ("merge_all_windows", "Merge All Windows", None),
    // Help
    ("help", "Folio Help", None),
    ("show_logs", "Show Logs", None),
];

/// (id, label, accelerator) for check items.
pub const CHECKS: &[(&str, &str, Option<&str>)] = &[
    ("view_preview", "Preview", None),
    ("view_code", "Code", None),
    ("view_split", "Split", None),
    ("sidebar_outline", "Outline", None),
    ("sidebar_files", "Files", None),
    ("soft_wrap", "Soft Wrap", Some("Alt+Z")),
    ("status_bar", "Status Bar", None),
    ("appearance_system", "System", None),
    ("appearance_light", "Light", None),
    ("appearance_dark", "Dark", None),
    ("width_narrow", "Narrow", None),
    ("width_medium", "Medium", None),
    ("width_wide", "Wide", None),
    ("width_full", "Full Width", None),
];

/// Items that act on the focused document window and need one.
const DOCUMENT_ACTIONS: &[&str] = &[
    "close_tab", "reload", "open_in_editor", "reveal_in_finder", "export_html", "print",
    "copy_markdown", "copy_html", "find", "find_next", "find_previous", "find_selection",
    "toggle_code", "toggle_split", "view_preview", "view_code", "view_split", "go_back",
    "go_forward", "next_heading", "previous_heading", "move_tab_to_new_window",
];

/// Items forwarded to the focused window's frontend as `menu-action`.
const FRONTEND_ACTIONS: &[&str] = &[
    "new_tab", "open_quickly", "close_tab", "reopen_closed_tab", "reload", "open_in_editor",
    "reveal_in_finder", "export_html", "print", "copy_markdown", "copy_html", "select_all",
    "find", "find_next", "find_previous", "find_selection", "toggle_code", "toggle_split",
    "toggle_sidebar", "view_preview", "view_code", "view_split", "sidebar_outline",
    "sidebar_files", "go_back", "go_forward", "next_heading", "previous_heading",
    "previous_tab", "next_tab", "move_tab_to_new_window",
];

#[derive(Default)]
pub struct MenuHandles {
    items: HashMap<&'static str, MenuItem<Wry>>,
    checks: HashMap<&'static str, CheckMenuItem<Wry>>,
    recent: Option<Submenu<Wry>>,
    recent_paths: Vec<String>,
    themes: Option<Submenu<Wry>>,
    theme_items: Vec<(String, CheckMenuItem<Wry>)>,
}

#[derive(Default)]
pub struct MenuStore(pub Mutex<MenuHandles>);

fn sep(app: &AppHandle) -> tauri::Result<PredefinedMenuItem<Wry>> {
    PredefinedMenuItem::separator(app)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let mut handles = MenuHandles::default();
    for (id, label, accel) in ITEMS {
        let item = MenuItem::with_id(app, *id, *label, true, *accel)?;
        handles.items.insert(id, item);
    }
    for (id, label, accel) in CHECKS {
        let item = CheckMenuItem::with_id(app, *id, *label, true, false, *accel)?;
        handles.checks.insert(id, item);
    }
    let i = |id: &str| -> &dyn IsMenuItem<Wry> { &handles.items[id] };
    let c = |id: &str| -> &dyn IsMenuItem<Wry> { &handles.checks[id] };

    let name = app.package_info().name.clone();
    let about = PredefinedMenuItem::about(
        app,
        Some(&format!("About {name}")),
        Some(
            AboutMetadataBuilder::new()
                .name(Some(name.clone()))
                .version(Some(app.package_info().version.to_string()))
                .comments(Some("A quiet Markdown viewer."))
                .copyright(app.config().bundle.copyright.clone())
                .build(),
        ),
    )?;
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &about,
            &sep(app)?,
            i("settings"),
            i("install_cli"),
            &sep(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &sep(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {name}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep(app)?,
            &PredefinedMenuItem::quit(app, Some(&format!("Quit {name}")))?,
        ],
    )?;

    let recent = Submenu::with_id(app, "open_recent", "Open Recent", true)?;
    let export = Submenu::with_items(app, "Export", true, &[i("export_html")])?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            i("new_window"),
            i("new_tab"),
            i("open"),
            i("open_folder"),
            i("open_quickly"),
            &recent,
            &sep(app)?,
            i("close_tab"),
            i("close_window"),
            i("reopen_closed_tab"),
            &sep(app)?,
            i("reload"),
            i("open_in_editor"),
            i("reveal_in_finder"),
            &sep(app)?,
            &export,
            i("print"),
        ],
    )?;

    let find_menu = Submenu::with_items(
        app,
        "Find",
        true,
        &[i("find"), i("find_next"), i("find_previous"), i("find_selection")],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            i("copy_markdown"),
            i("copy_html"),
            i("select_all"),
            &sep(app)?,
            &find_menu,
        ],
    )?;

    let appearance = Submenu::with_items(
        app,
        "Appearance",
        true,
        &[c("appearance_system"), c("appearance_light"), c("appearance_dark")],
    )?;
    let themes = Submenu::with_id(app, "themes", "Theme", true)?;
    let width = Submenu::with_items(
        app,
        "Reading Width",
        true,
        &[c("width_narrow"), c("width_medium"), c("width_wide"), c("width_full")],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            c("view_preview"),
            c("view_code"),
            c("view_split"),
            &sep(app)?,
            i("toggle_code"),
            i("toggle_split"),
            &sep(app)?,
            i("toggle_sidebar"),
            c("sidebar_outline"),
            c("sidebar_files"),
            &sep(app)?,
            c("soft_wrap"),
            c("status_bar"),
            &sep(app)?,
            &appearance,
            &themes,
            &width,
            &sep(app)?,
            i("zoom_reset"),
            i("zoom_in"),
            i("zoom_out"),
            &sep(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let go_menu = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            i("go_back"),
            i("go_forward"),
            &sep(app)?,
            i("next_heading"),
            i("previous_heading"),
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &sep(app)?,
            i("previous_tab"),
            i("next_tab"),
            &sep(app)?,
            i("move_tab_to_new_window"),
            i("merge_all_windows"),
            &sep(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(app, "Help", true, &[i("help"), i("show_logs")])?;

    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &window_menu,
            &help_menu,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        window_menu.set_as_windows_menu_for_nsapp()?;
        help_menu.set_as_help_menu_for_nsapp()?;
    }

    handles.recent = Some(recent);
    handles.themes = Some(themes);
    *app.state::<MenuStore>().0.lock() = handles;
    Ok(menu)
}

/// Rebuilds File ▸ Open Recent (with Finder icons) from the recents list.
pub fn rebuild_recents(app: &AppHandle, items: &[RecentItem]) {
    let store = app.state::<MenuStore>();
    let mut handles = store.0.lock();
    let Some(submenu) = handles.recent.clone() else {
        return;
    };
    if let Ok(existing) = submenu.items() {
        for item in existing {
            let _ = submenu.remove(&item);
        }
    }
    let mut paths = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let icon = crate::macos::file_icon_rgba(std::path::Path::new(&item.path), 32)
            .map(|(rgba, w, h)| Image::new_owned(rgba, w, h));
        if let Ok(entry) = IconMenuItem::with_id(
            app,
            format!("recent:{index}"),
            &item.name,
            true,
            icon,
            None::<&str>,
        ) {
            let _ = submenu.append(&entry);
        }
        paths.push(item.path.clone());
    }
    if !items.is_empty() {
        if let Ok(s) = sep(app) {
            let _ = submenu.append(&s);
        }
    }
    if let Some(clear) = handles.items.get("clear_recents") {
        let _ = clear.set_enabled(!items.is_empty());
        let _ = submenu.append(clear);
    }
    handles.recent_paths = paths;
}

/// Rebuilds View ▸ Theme from the built-in and custom themes.
pub fn rebuild_themes(app: &AppHandle, custom: &[String], current: &str) {
    let store = app.state::<MenuStore>();
    let mut handles = store.0.lock();
    let Some(submenu) = handles.themes.clone() else {
        return;
    };
    if let Ok(existing) = submenu.items() {
        for item in existing {
            let _ = submenu.remove(&item);
        }
    }
    let mut theme_items = Vec::new();
    let mut entries: Vec<(String, String)> = vec![
        ("claude".into(), "Claude".into()),
        ("github".into(), "GitHub".into()),
        ("paper".into(), "Paper".into()),
    ];
    for name in custom {
        entries.push((format!("custom:{name}"), name.clone()));
    }
    for (index, (key, label)) in entries.iter().enumerate() {
        if index == 3 {
            if let Ok(s) = sep(app) {
                let _ = submenu.append(&s);
            }
        }
        if let Ok(item) = CheckMenuItem::with_id(
            app,
            format!("theme:{key}"),
            label,
            true,
            key == current,
            None::<&str>,
        ) {
            let _ = submenu.append(&item);
            theme_items.push((key.clone(), item));
        }
    }
    if let Ok(s) = sep(app) {
        let _ = submenu.append(&s);
    }
    if let Some(open) = handles.items.get("open_themes_folder") {
        let _ = submenu.append(open);
    }
    handles.theme_items = theme_items;
}

/// Reflects settings (appearance, theme, width, soft wrap, status bar).
pub fn sync_settings(app: &AppHandle, s: &Settings) {
    let store = app.state::<MenuStore>();
    let handles = store.0.lock();
    let set = |id: &str, on: bool| {
        if let Some(item) = handles.checks.get(id) {
            let _ = item.set_checked(on);
        }
    };
    set("appearance_system", s.appearance == Appearance::System);
    set("appearance_light", s.appearance == Appearance::Light);
    set("appearance_dark", s.appearance == Appearance::Dark);
    set("width_narrow", s.reading_width == ReadingWidth::Narrow);
    set("width_medium", s.reading_width == ReadingWidth::Medium);
    set("width_wide", s.reading_width == ReadingWidth::Wide);
    set("width_full", s.reading_width == ReadingWidth::Full);
    set("soft_wrap", s.soft_wrap);
    set("status_bar", s.status_bar);
    for (key, item) in &handles.theme_items {
        let _ = item.set_checked(key == &s.theme);
    }
}

/// Enables/checks items for the focused window (or none).
pub fn apply_state(app: &AppHandle, state: Option<&MenuState>) {
    let store = app.state::<MenuStore>();
    let handles = store.0.lock();
    let empty = MenuState::default();
    let has_window = state.is_some();
    let st = state.unwrap_or(&empty);
    let enable = |id: &str, on: bool| {
        if let Some(item) = handles.items.get(id) {
            let _ = item.set_enabled(on);
        }
        if let Some(item) = handles.checks.get(id) {
            let _ = item.set_enabled(on);
        }
    };
    for id in DOCUMENT_ACTIONS {
        enable(id, st.has_document);
    }
    let md = st.has_document && st.is_markdown;
    enable("view_preview", md);
    enable("view_split", md);
    enable("toggle_code", md);
    enable("toggle_split", md);
    enable("go_back", st.can_go_back);
    enable("go_forward", st.can_go_forward);
    enable("next_heading", st.has_headings);
    enable("previous_heading", st.has_headings);
    enable("reopen_closed_tab", has_window && st.has_closed_tabs);
    enable("new_tab", has_window);
    enable("open_quickly", has_window);
    enable("close_window", has_window);
    enable("select_all", has_window);
    enable("toggle_sidebar", has_window);
    enable("sidebar_outline", has_window);
    enable("sidebar_files", has_window && st.has_folder);
    enable("previous_tab", st.tab_count > 1);
    enable("next_tab", st.tab_count > 1);
    enable("move_tab_to_new_window", st.has_document && st.tab_count > 1);
    enable("zoom_in", has_window);
    enable("zoom_out", has_window);
    enable("zoom_reset", has_window);

    let check = |id: &str, on: bool| {
        if let Some(item) = handles.checks.get(id) {
            let _ = item.set_checked(on);
        }
    };
    check("view_preview", st.has_document && st.view_mode == ViewMode::Preview);
    check("view_code", st.has_document && st.view_mode == ViewMode::Code);
    check("view_split", st.has_document && st.view_mode == ViewMode::Split);
    check("sidebar_outline", st.sidebar_visible && st.sidebar_pane == "outline");
    check("sidebar_files", st.sidebar_visible && st.sidebar_pane == "files");

    let text = |id: &str, t: &str| {
        if let Some(item) = handles.items.get(id) {
            let _ = item.set_text(t);
        }
    };
    text(
        "toggle_code",
        if st.view_mode == ViewMode::Code { "Show Preview" } else { "Show Code" },
    );
    text(
        "toggle_split",
        if st.view_mode == ViewMode::Split { "Hide Split" } else { "Show Split" },
    );
    text(
        "toggle_sidebar",
        if st.sidebar_visible { "Hide Sidebar" } else { "Show Sidebar" },
    );
}

/// Refreshes menu state from whichever window is key.
pub fn refresh(app: &AppHandle) {
    let registry = app.state::<Registry>();
    let focused = crate::focused_document_window(app);
    let snapshot = focused.and_then(|l| registry.snapshot(&l));
    apply_state(app, snapshot.as_ref().map(|s| &s.menu));
}

fn emit_to_focused(app: &AppHandle, action: &str, arg: Value) -> bool {
    let target = crate::focused_document_window(app)
        .or_else(|| app.state::<Registry>().frontmost());
    match target {
        Some(label) => {
            let _ = app.emit_to(label.as_str(), "menu-action", json!({ "action": action, "arg": arg }));
            true
        }
        None => false,
    }
}

fn update_setting(app: &AppHandle, patch: Value) {
    let state = app.state::<SettingsState>();
    let next = state.update(&patch);
    crate::settings::broadcast(app, &next);
}

pub fn handle(app: &AppHandle, id: &str) {
    log::debug!("menu: {id}");
    if let Some(rest) = id.strip_prefix("ctx:") {
        crate::commands::handle_context_menu(app, rest);
        return;
    }
    if let Some(rest) = id.strip_prefix("pathmenu:") {
        if let Some((token, index)) = rest.split_once(':') {
            if let Ok(index) = index.parse::<usize>() {
                crate::commands::handle_path_menu(app, token, index);
            }
        }
        return;
    }
    if let Some(index) = id.strip_prefix("recent:") {
        let path = index
            .parse::<usize>()
            .ok()
            .and_then(|i| app.state::<MenuStore>().0.lock().recent_paths.get(i).cloned());
        if let Some(path) = path {
            crate::router::open_paths(
                app,
                vec![PathBuf::from(path)],
                crate::open_queue::OpenOptions {
                    source: crate::open_queue::OpenSource::Recent,
                    ..Default::default()
                },
            );
        }
        return;
    }
    if let Some(theme) = id.strip_prefix("theme:") {
        update_setting(app, json!({ "theme": theme }));
        return;
    }
    match id {
        "settings" => crate::windows::create_settings_window(app),
        "install_cli" => crate::cli_install::install_interactive(app),
        "new_window" => {
            crate::windows::create_document_window(app, Default::default(), Vec::new());
        }
        "open" => {
            crate::commands::show_open_panel_for(app, crate::focused_document_window(app), false)
        }
        "open_folder" => {
            crate::commands::show_open_panel_for(app, crate::focused_document_window(app), true)
        }
        "clear_recents" => crate::recents::clear(app),
        "close_window" => {
            if let Some(w) = crate::focused_window(app) {
                let _ = w.close();
            }
        }
        "close_tab" if crate::focused_window_label(app).as_deref()
            == Some(crate::windows::SETTINGS_LABEL) =>
        {
            if let Some(w) = app.get_webview_window(crate::windows::SETTINGS_LABEL) {
                let _ = w.close();
            }
        }
        "soft_wrap" => {
            let on = !app.state::<SettingsState>().get().soft_wrap;
            update_setting(app, json!({ "softWrap": on }));
        }
        "status_bar" => {
            let on = !app.state::<SettingsState>().get().status_bar;
            update_setting(app, json!({ "statusBar": on }));
        }
        "appearance_system" => update_setting(app, json!({ "appearance": "system" })),
        "appearance_light" => update_setting(app, json!({ "appearance": "light" })),
        "appearance_dark" => update_setting(app, json!({ "appearance": "dark" })),
        "width_narrow" => update_setting(app, json!({ "readingWidth": "narrow" })),
        "width_medium" => update_setting(app, json!({ "readingWidth": "medium" })),
        "width_wide" => update_setting(app, json!({ "readingWidth": "wide" })),
        "width_full" => update_setting(app, json!({ "readingWidth": "full" })),
        "zoom_in" | "zoom_out" | "zoom_reset" => {
            let current = app.state::<SettingsState>().get().text_zoom;
            let next = match id {
                "zoom_in" => crate::settings::zoom_step(current, 1),
                "zoom_out" => crate::settings::zoom_step(current, -1),
                _ => 1.0,
            };
            update_setting(app, json!({ "textZoom": next }));
        }
        "open_themes_folder" => crate::themes::reveal_folder(app),
        "merge_all_windows" => crate::commands::merge_all_windows(app),
        "help" => crate::router::open_help(app),
        "show_logs" => crate::commands::show_logs(app),
        other if FRONTEND_ACTIONS.contains(&other) => {
            if !emit_to_focused(app, other, Value::Null) && other == "new_tab" {
                crate::windows::create_document_window(app, Default::default(), Vec::new());
            }
        }
        other => log::debug!("unhandled menu item {other}"),
    }
    // Checkmarks for settings-backed items are reset from the source of
    // truth (the click itself toggles them natively).
    let settings = app.state::<SettingsState>().get();
    sync_settings(app, &settings);
    refresh(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn every_accelerator_parses() {
        for (id, _, accel) in ITEMS.iter().chain(CHECKS) {
            if let Some(a) = accel {
                assert!(
                    muda::accelerator::Accelerator::from_str(a).is_ok(),
                    "{id}: {a} does not parse"
                );
            }
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<&str> = ITEMS.iter().chain(CHECKS).map(|(id, _, _)| *id).collect();
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn frontend_and_document_actions_exist() {
        let all: Vec<&str> = ITEMS.iter().chain(CHECKS).map(|(id, _, _)| *id).collect();
        for id in FRONTEND_ACTIONS.iter().chain(DOCUMENT_ACTIONS) {
            assert!(all.contains(id), "{id} has no menu item");
        }
    }
}
