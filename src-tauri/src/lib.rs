//! Folio — a native Markdown viewer for macOS.

mod access;
mod cli_install;
mod commands;
mod deeplink;
mod documents;
mod editor;
mod folders;
mod macos;
mod menu;
mod open_queue;
mod paths;
mod perf;
mod recents;
mod registry;
mod router;
mod session;
mod settings;
mod themes;
mod watcher;
mod windows;

use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, DragDropEvent, Manager, RunEvent, WebviewWindow, Window, WindowEvent};
use tauri_plugin_log::{Target, TargetKind};

use access::Access;
use open_queue::{OpenOptions, OpenQueue, OpenSource};
use registry::Registry;
use session::SessionState;
use settings::SettingsState;

/// The key window's label, if any window of this app is key.
pub fn focused_window_label(app: &AppHandle) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

pub fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    focused_window_label(app).and_then(|l| app.get_webview_window(&l))
}

/// The key window if it is a document window.
pub fn focused_document_window(app: &AppHandle) -> Option<String> {
    focused_window_label(app).filter(|l| l.starts_with("doc-"))
}

fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .level(log::LevelFilter::Info)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("notify", log::LevelFilter::Warn)
        .max_file_size(2_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne);
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            builder = builder.target(Target::new(TargetKind::Folder {
                path: PathBuf::from(home).join("Library/Logs/Folio"),
                file_name: Some("Folio".into()),
            }));
        }
    } else {
        builder = builder.target(Target::new(TargetKind::LogDir {
            file_name: Some("Folio".into()),
        }));
    }
    if cfg!(debug_assertions) || std::env::var_os("FOLIO_LOG_STDOUT").is_some() {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder.build()
}

pub fn run() {
    perf::init();
    let app = tauri::Builder::default()
        .plugin(log_plugin())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        // State must exist before the event loop starts: `RunEvent::Opened`
        // can arrive before `setup` on a cold launch.
        .manage(OpenQueue::default())
        .manage(Registry::default())
        .manage(Access::default())
        .manage(SettingsState::default())
        .manage(SessionState::default())
        .manage(recents::Recents::default())
        .manage(watcher::Watcher::default())
        .manage(themes::ThemeWatcher::default())
        .manage(menu::MenuStore::default())
        .manage(commands::BannerState::default())
        .manage(commands::Downloads::default())
        .manage(commands::PathMenus::default())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::take_window_init,
            commands::take_pending_opens,
            commands::window_ready,
            commands::registry_update,
            commands::perf_mark,
            commands::toolbar_double_click,
            commands::start_window_drag,
            commands::close_window,
            commands::new_window,
            commands::open_settings,
            commands::read_document,
            commands::resolve_link,
            commands::allow_images,
            commands::image_data_urls,
            commands::list_folder,
            commands::open_dropped,
            commands::open_granted,
            commands::show_open_panel,
            commands::locate_file,
            commands::move_tab_to_new_window,
            commands::merge_windows,
            commands::list_open_documents,
            commands::reveal_in_finder,
            commands::open_external,
            commands::open_in_editor,
            commands::list_editors,
            commands::show_logs_folder,
            commands::popup_menu,
            commands::popup_path_menu,
            commands::print_window,
            commands::export_html,
            commands::copy_to_clipboard,
            commands::get_settings,
            commands::update_settings,
            commands::reset_settings,
            commands::get_recents,
            commands::clear_recents,
            commands::get_reading_position,
            commands::save_reading_position,
            commands::list_themes,
            commands::open_themes_folder,
            commands::default_app_status,
            commands::make_default_app,
            commands::dismiss_default_app_banner,
            commands::install_cli,
        ])
        .setup(|app| {
            setup(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Folio");

    app.run(on_run_event);
}

fn setup(app: &AppHandle) {
    perf::mark(app, "setup");
    macos::init(app);
    if let Ok(dir) = app.path().resource_dir() {
        app.state::<Access>().set_resource_dir(dir);
    }
    app.state::<SettingsState>().load(app);
    app.state::<recents::Recents>().load(app);
    let settings = app.state::<SettingsState>().get();

    let recent_items = app.state::<recents::Recents>().items();
    menu::rebuild_recents(app, &recent_items);
    themes::start(app);
    menu::sync_settings(app, &settings);
    menu::apply_state(app, None);
    app.state::<watcher::Watcher>().start(app);
    session::start_autosave(app);
    clean_stdin_dir(app);

    // First launch: offer Make Default once, in the first window.
    if !settings.default_app_banner_shown {
        let status = macos::default_app_status();
        if status.supported && !status.is_default {
            app.state::<commands::BannerState>()
                .0
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    let queue = app.state::<OpenQueue>();
    queue.set_ready();
    session::restore(app);
    for (paths, opts) in queue.take_cold() {
        router::open_paths(app, paths, opts);
    }
    let argv = argv_paths(app);
    if !argv.is_empty() {
        router::open_paths(
            app,
            argv,
            OpenOptions {
                source: OpenSource::Cli,
                ..Default::default()
            },
        );
    }

    // Nothing opened or restored: show the Welcome window, after a short
    // grace period in case the launch Apple Event arrives late.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if windows::document_windows(&inner).is_empty() {
                windows::create_document_window(&inner, Default::default(), Vec::new());
            }
        });
    });
}

/// Paths passed on the command line (development, Linux). On macOS,
/// Finder and `open` deliver files through `RunEvent::Opened` instead.
/// `folio://` links arrive the same way on Linux (via the deep-link plugin's
/// desktop entry).
fn argv_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for arg in std::env::args().skip(1) {
        if arg.starts_with("folio:") {
            if let Some(link) = tauri::Url::parse(&arg).ok().as_ref().and_then(deeplink::parse) {
                router::open_paths(
                    app,
                    link.paths,
                    OpenOptions {
                        view: link.view,
                        line: link.line,
                        new_window: link.new_window,
                        stdin: link.stdin,
                        source: OpenSource::Cli,
                        ..Default::default()
                    },
                );
            }
        } else if !arg.starts_with('-') {
            let p = PathBuf::from(arg);
            if p.exists() {
                out.push(p);
            }
        }
    }
    out
}

/// Standard Input temp files from `folio -` are removed on the next launch
/// (but not ones that are about to be opened).
fn clean_stdin_dir(app: &AppHandle) {
    let dir = paths::stdin_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let pending = app.state::<OpenQueue>().cold_paths();
    for entry in entries.flatten() {
        let path = entry.path();
        let fresh = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age < Duration::from_secs(60));
        let pending_open = pending
            .iter()
            .any(|p| paths::best_effort_canonical(p) == paths::best_effort_canonical(&path));
        if !fresh && !pending_open {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let label = window.label();
    match event {
        WindowEvent::Focused(true) => {
            if label.starts_with("doc-") {
                app.state::<Registry>().note_focus(label);
            }
            menu::refresh(app);
            // Events can be missed while inactive or asleep.
            watcher::recheck_all(app);
        }
        WindowEvent::Destroyed => {
            let registry = app.state::<Registry>();
            registry.remove_window(label);
            app.state::<OpenQueue>().forget_window(label);
            app.state::<watcher::Watcher>().sync(&registry.open_paths());
            app.state::<SessionState>().mark_dirty();
            menu::refresh(app);
        }
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            if label.starts_with("doc-") {
                app.state::<SessionState>().mark_dirty();
                if let Some(w) = app.get_webview_window(label) {
                    remember_window_size(app, &w);
                    let fullscreen = w.is_fullscreen().unwrap_or(false);
                    let _ = tauri::Emitter::emit_to(
                        app,
                        label,
                        "window-state",
                        serde_json::json!({ "fullscreen": fullscreen }),
                    );
                }
            }
        }
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
            app.state::<Access>().record_drop(paths);
        }
        WindowEvent::ThemeChanged(_) => {
            if let Some(w) = app.get_webview_window(label) {
                let settings = app.state::<SettingsState>().get();
                windows::apply_background(app, &w, &settings);
            }
        }
        _ => {}
    }
}

/// New windows open at the size of the last window the user sized.
fn remember_window_size(app: &AppHandle, window: &WebviewWindow) {
    if window.is_fullscreen().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    if let Some(frame) = windows::frame_of(window) {
        app.state::<SettingsState>()
            .set_in_memory(|s| s.last_window_size = Some((frame.width, frame.height)));
    }
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => handle_opened_urls(app, urls),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows && app.state::<OpenQueue>().is_ready() {
                let docs = windows::document_windows(app);
                match docs.first() {
                    // Minimized windows: bring one back.
                    Some(w) => {
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                    None => {
                        windows::create_document_window(app, Default::default(), Vec::new());
                    }
                }
            }
        }
        RunEvent::ExitRequested { code, api, .. } => {
            // Closing the last window keeps Folio running (like Preview).
            // Quit (⌘Q) and `app.exit()` pass through.
            if code.is_none() && !app.state::<SessionState>().is_quitting() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            let session = app.state::<SessionState>();
            if !session.is_quitting() {
                session::save_now(app);
                session.set_quitting();
            }
            app.state::<SettingsState>().persist_now();
        }
        _ => {}
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn handle_opened_urls(app: &AppHandle, urls: Vec<tauri::Url>) {
    perf::note_open();
    perf::mark(app, "opened");
    let mut files = Vec::new();
    for url in urls {
        match url.scheme() {
            "file" => {
                if let Ok(p) = url.to_file_path() {
                    files.push(p);
                }
            }
            "folio" => {
                if let Some(link) = deeplink::parse(&url) {
                    router::open_paths(
                        app,
                        link.paths,
                        OpenOptions {
                            view: link.view,
                            line: link.line,
                            new_window: link.new_window,
                            stdin: link.stdin,
                            source: OpenSource::Cli,
                            ..Default::default()
                        },
                    );
                }
            }
            other => log::warn!("ignoring opened URL with scheme {other}"),
        }
    }
    if !files.is_empty() {
        router::open_paths(app, files, OpenOptions::default());
    }
}
