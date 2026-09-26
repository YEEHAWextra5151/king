//! Tauri commands: thin, validated wrappers. Every path argument is checked
//! against the access policy before anything touches the filesystem.

use base64::Engine;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::menu::{CheckMenuItem, IconMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::access::{Access, LinkTarget};
use crate::documents::{self, DocKind, ErrorCode, ReadResult};
use crate::folders::{self, FolderListing};
use crate::macos::{self, DefaultAppStatus};
use crate::open_queue::{OpenOptions, OpenQueue, OpenRequest, OpenSource, TargetKind, WindowInit};
use crate::paths;
use crate::recents::{ReadingPosition, RecentItem, Recents};
use crate::registry::{Registry, WindowSnapshot};
use crate::session::SessionState;
use crate::settings::{Settings, SettingsState};
use crate::themes::{self, CustomTheme};
use crate::watcher::{self, Watcher};
use crate::{cli_install, editor, perf, router, windows};

/// Set at launch when the first window should offer "Make Default".
#[derive(Default)]
pub struct BannerState(pub std::sync::atomic::AtomicBool);

/// Files currently being fetched from iCloud (so each is fetched once).
#[derive(Default)]
pub struct Downloads(Mutex<HashSet<PathBuf>>);

/// Paths behind the items of an open ⌘-click path menu.
#[derive(Default)]
pub struct PathMenus(pub Mutex<HashMap<String, Vec<PathBuf>>>);

// ─── Window lifecycle ──────────────────────────────────────────────────────

#[tauri::command]
pub fn take_window_init(app: AppHandle, window: WebviewWindow) -> WindowInit {
    let mut init = app.state::<OpenQueue>().take_init(window.label());
    let banner = app.state::<BannerState>();
    if window.label().starts_with("doc-")
        && banner.0.swap(false, std::sync::atomic::Ordering::SeqCst)
    {
        init.show_default_app_banner = true;
        // Shown once, ever.
        app.state::<SettingsState>()
            .set_internal(|s| s.default_app_banner_shown = true);
    }
    init
}

#[tauri::command]
pub fn take_pending_opens(app: AppHandle, window: WebviewWindow) -> Vec<OpenRequest> {
    app.state::<OpenQueue>().take_for_window(window.label())
}

#[tauri::command]
pub fn window_ready(app: AppHandle, window: WebviewWindow) {
    windows::reveal(&window);
    perf::mark(&app, &format!("window-shown {}", window.label()));
}

#[tauri::command]
pub fn registry_update(app: AppHandle, window: WebviewWindow, snapshot: WindowSnapshot) {
    let label = window.label().to_string();
    let title = snapshot
        .active_tab()
        .map(|t| t.title.clone())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Folio".into());
    let registry = app.state::<Registry>();
    registry.update(&label, snapshot);
    // Hidden, but shown in the Window menu, Mission Control and VoiceOver.
    let _ = window.set_title(&title);
    app.state::<Watcher>().sync(&registry.open_paths());
    app.state::<SessionState>().mark_dirty();
    if crate::focused_document_window(&app).as_deref() == Some(label.as_str()) {
        crate::menu::refresh(&app);
    }
}

#[tauri::command]
pub fn perf_mark(app: AppHandle, name: String) {
    perf::mark(&app, &name);
}

#[tauri::command]
pub fn toolbar_double_click(window: WebviewWindow) {
    macos::perform_double_click(&window);
}

#[tauri::command]
pub fn start_window_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
pub fn close_window(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub async fn new_window(app: AppHandle) {
    windows::create_document_window(&app, WindowInit::default(), Vec::new());
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    windows::create_settings_window(&app);
}

// ─── Documents ─────────────────────────────────────────────────────────────

fn not_allowed(path: &Path) -> ReadResult {
    ReadResult::error(
        path,
        ErrorCode::NotAllowed,
        "Folio can only show files you open.",
    )
}

#[tauri::command]
pub async fn read_document(app: AppHandle, path: String, as_text: Option<bool>) -> ReadResult {
    let p = PathBuf::from(&path);
    if !app.state::<Access>().can_read(&p) {
        return not_allowed(&p);
    }
    let kind = if as_text.unwrap_or(false) || (!paths::is_markdown(&p) && paths::is_known_text(&p)) {
        DocKind::Text
    } else {
        DocKind::Markdown
    };
    let read_path = p.clone();
    let result = tauri::async_runtime::spawn_blocking(move || documents::read(&read_path, kind))
        .await
        .unwrap_or_else(|e| ReadResult::error(&p, ErrorCode::Other, e.to_string()));
    if matches!(result, ReadResult::Downloading { .. }) {
        start_download(&app, &p);
    }
    perf::mark(&app, "document-read");
    result
}

/// Materializes an iCloud placeholder in the background, then tells the
/// windows showing it to re-read.
fn start_download(app: &AppHandle, path: &Path) {
    if !app.state::<Downloads>().0.lock().insert(path.to_path_buf()) {
        return;
    }
    let app = app.clone();
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        if documents::icloud_stub_for(&path).is_some() {
            macos::start_downloading(&path);
            for _ in 0..600 {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if path.exists() {
                    break;
                }
            }
        }
        // Reading a dataless file blocks until it has been downloaded.
        let _ = std::fs::read(&path);
        app.state::<Downloads>().0.lock().remove(&path);
        watcher::notify_ready(&app, &path);
    });
}

#[tauri::command]
pub fn resolve_link(app: AppHandle, from: String, href: String, root: Option<String>) -> LinkTarget {
    let access = app.state::<Access>();
    let from = PathBuf::from(from);
    if !access.can_read(&from) {
        return LinkTarget::blocked();
    }
    let root = root.map(PathBuf::from).filter(|r| access.can_list(r));
    access.resolve_link(&from, &href, root.as_deref())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantedImage {
    pub path: String,
    /// Intrinsic size, when cheaply known, so the page can reserve space
    /// before the image loads (no layout shift).
    pub width: Option<usize>,
    pub height: Option<usize>,
}

/// Grants each local image a document references, file by file, to the
/// asset protocol. Returns src → granted image (null if not a local image).
#[tauri::command]
pub async fn allow_images(
    app: AppHandle,
    doc: String,
    srcs: Vec<String>,
    root: Option<String>,
) -> HashMap<String, Option<GrantedImage>> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let access = handle.state::<Access>();
        let doc = PathBuf::from(doc);
        let mut out = HashMap::new();
        if !access.can_read(&doc) {
            return out;
        }
        let root = root.map(PathBuf::from).filter(|r| access.can_list(r));
        let scope = handle.asset_protocol_scope();
        for src in srcs.into_iter().take(5000) {
            let resolved = access.resolve_image(&doc, &src, root.as_deref());
            let granted = resolved.map(|img| {
                if let Err(err) = scope.allow_file(&img) {
                    log::warn!("asset scope: {err}");
                }
                access.note_image(&img);
                let size = imagesize::size(&img).ok();
                GrantedImage {
                    path: paths::to_string(&img),
                    width: size.map(|s| s.width),
                    height: size.map(|s| s.height),
                }
            });
            out.insert(src, granted);
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Data URLs for images already granted (Export ▸ HTML inlines them).
#[tauri::command]
pub async fn image_data_urls(app: AppHandle, paths: Vec<String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for p in paths.into_iter().take(2000) {
        let path = PathBuf::from(&p);
        if !app.state::<Access>().is_granted_image(&path) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes.len() > 25 * 1024 * 1024 {
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let mime = match ext.as_str() {
            "png" | "apng" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "avif" => "image/avif",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "tif" | "tiff" => "image/tiff",
            "heic" | "heif" => "image/heic",
            _ => "application/octet-stream",
        };
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        out.insert(p, format!("data:{mime};base64,{data}"));
    }
    out
}

#[tauri::command]
pub async fn list_folder(app: AppHandle, root: String) -> Result<FolderListing, String> {
    let root = PathBuf::from(root);
    if !app.state::<Access>().can_list(&root) {
        return Err("Folio can only list folders you open.".into());
    }
    tauri::async_runtime::spawn_blocking(move || folders::list(&root))
        .await
        .map_err(|e| e.to_string())
}

// ─── Opening ───────────────────────────────────────────────────────────────

/// Files dropped on a window. Only paths Rust saw in the native drop event
/// are accepted.
#[tauri::command]
pub async fn open_dropped(
    app: AppHandle,
    window: WebviewWindow,
    paths: Vec<String>,
    insert_at: Option<usize>,
) {
    let claimed: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let access = app.state::<Access>();
    let mut verified = access.verify_dropped(&claimed);
    // The native drop event and this call can race; give it a moment.
    for _ in 0..10 {
        if verified.len() == claimed.len() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        verified = access.verify_dropped(&claimed);
    }
    router::open_paths(
        &app,
        verified,
        OpenOptions {
            target_window: Some(window.label().to_string()),
            insert_at,
            source: OpenSource::Drop,
            ..Default::default()
        },
    );
}

/// Opens an already-granted path (a followed link, a sidebar file, a
/// recent item) through the router, so dedupe applies.
#[tauri::command]
pub async fn open_granted(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    new_window: Option<bool>,
    view: Option<crate::settings::ViewMode>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let access = app.state::<Access>();
    let allowed = access.can_read(&p)
        || app.state::<Recents>().items().iter().any(|i| i.path == path);
    if !allowed {
        return Err("Folio can only open files you choose.".into());
    }
    router::open_paths(
        &app,
        vec![p],
        OpenOptions {
            target_window: Some(window.label().to_string()),
            new_window: new_window.unwrap_or(false),
            view,
            source: OpenSource::Recent,
            ..Default::default()
        },
    );
    Ok(())
}

pub fn show_open_panel_for(app: &AppHandle, label: Option<String>, folders_only: bool) {
    let registry = app.state::<Registry>();
    let start_dir = label.as_deref().and_then(|l| registry.snapshot(l)).and_then(|s| {
        s.folder.clone().map(PathBuf::from).or_else(|| {
            s.active_tab()
                .and_then(|t| t.path.as_deref())
                .and_then(|p| Path::new(p).parent().map(Path::to_path_buf))
        })
    });
    let handle = app.clone();
    macos::show_open_panel(
        app,
        start_dir,
        folders_only,
        Box::new(move |chosen| {
            if chosen.is_empty() {
                return;
            }
            router::open_paths(
                &handle,
                chosen,
                OpenOptions {
                    source: OpenSource::Panel,
                    ..Default::default()
                },
            );
        }),
    );
}

#[tauri::command]
pub fn show_open_panel(app: AppHandle, window: WebviewWindow, folders_only: Option<bool>) {
    show_open_panel_for(&app, Some(window.label().to_string()), folders_only.unwrap_or(false));
}

/// "Locate…" for a moved or deleted file.
#[tauri::command]
pub async fn locate_file(app: AppHandle, path: String) -> Option<String> {
    let old = PathBuf::from(&path);
    if !app.state::<Access>().can_read(&old) {
        return None;
    }
    let mut builder = app
        .dialog()
        .file()
        .set_title(format!("Locate “{}”", paths::display_name(&old)))
        .add_filter("Markdown", paths::MARKDOWN_EXTENSIONS);
    if let Some(dir) = old.parent().filter(|d| d.exists()) {
        builder = builder.set_directory(dir);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_pick_file())
        .await
        .ok()
        .flatten()?;
    let new_path = picked.into_path().ok()?;
    let canonical = paths::canonical(&new_path)?;
    app.state::<Access>().grant_file(&canonical);
    crate::recents::note(&app, &canonical);
    Some(paths::to_string(&canonical))
}

#[tauri::command]
pub async fn move_tab_to_new_window(app: AppHandle, tab: Value) -> Result<String, String> {
    let path = tab
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or("tab has no document")?;
    let kind = if tab.get("kind").and_then(Value::as_str) == Some("text") {
        TargetKind::Text
    } else {
        TargetKind::Markdown
    };
    let mut req = OpenRequest::new(path, kind);
    req.tab = Some(tab);
    windows::create_document_window(&app, WindowInit::default(), vec![req])
        .ok_or_else(|| "could not create window".to_string())
}

pub fn merge_all_windows(app: &AppHandle) {
    let registry = app.state::<Registry>();
    let Some(target) = crate::focused_document_window(app).or_else(|| registry.frontmost()) else {
        return;
    };
    let target_has_folder = registry
        .snapshot(&target)
        .is_some_and(|s| s.folder.is_some());
    let mut requests = Vec::new();
    let mut adopted_folder = false;
    for entry in registry.all() {
        if entry.label == target || !entry.label.starts_with("doc-") {
            continue;
        }
        if let (false, false, Some(folder)) =
            (target_has_folder, adopted_folder, entry.snapshot.folder.clone())
        {
            requests.push(OpenRequest {
                activate: false,
                ..OpenRequest::new(folder, TargetKind::Folder)
            });
            adopted_folder = true;
        }
        for tab in &entry.snapshot.tabs {
            let Some(path) = tab.path.clone() else { continue };
            let mut req = OpenRequest::new(path, TargetKind::Markdown);
            req.activate = false;
            req.tab = serde_json::to_value(tab).ok();
            requests.push(req);
        }
        if let Some(w) = app.get_webview_window(&entry.label) {
            let _ = w.close();
        }
    }
    if !requests.is_empty() {
        router::push_to_window(app, &target, requests);
    }
}

#[tauri::command]
pub fn merge_windows(app: AppHandle) {
    merge_all_windows(&app);
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocument {
    pub path: String,
    pub title: String,
    pub window: String,
}

/// Every document open in any window (for Open Quickly).
#[tauri::command]
pub fn list_open_documents(app: AppHandle) -> Vec<OpenDocument> {
    app.state::<Registry>()
        .all()
        .into_iter()
        .flat_map(|w| {
            let label = w.label.clone();
            w.snapshot.tabs.into_iter().filter_map(move |t| {
                let path = t.path?;
                (!t.is_stdin).then(|| OpenDocument { path, title: t.title, window: label.clone() })
            })
        })
        .collect()
}

// ─── Finder, browser, editor ───────────────────────────────────────────────

pub fn reveal_path(app: &AppHandle, path: &Path) {
    if let Err(err) = app.opener().reveal_item_in_dir(path) {
        log::warn!("reveal failed: {err}");
    }
}

#[tauri::command]
pub fn reveal_in_finder(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !app.state::<Access>().can_reveal(&p) {
        return Err("not allowed".into());
    }
    reveal_path(&app, &p);
    Ok(())
}

pub fn open_external_url(app: &AppHandle, url: &str) {
    let Ok(parsed) = url::Url::parse(url) else {
        return;
    };
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        log::warn!("blocked external URL with scheme {}", parsed.scheme());
        return;
    }
    if let Err(err) = app.opener().open_url(parsed.as_str(), None::<&str>) {
        log::warn!("could not open {url}: {err}");
    }
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) {
    open_external_url(&app, &url);
}

#[tauri::command]
pub async fn open_in_editor(app: AppHandle, path: String, line: Option<u32>) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !app.state::<Access>().can_read(&p) {
        return Err("not allowed".into());
    }
    let setting = app.state::<SettingsState>().get().editor;
    tauri::async_runtime::spawn_blocking(move || editor::open(&setting, &p, line))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_editors() -> Vec<editor::EditorInfo> {
    editor::installed()
}

pub fn log_dir(app: &AppHandle) -> PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Logs/Folio");
        }
    }
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Folio-logs"))
}

pub fn show_logs(app: &AppHandle) {
    let dir = log_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    if let Err(err) = app.opener().open_path(dir.to_string_lossy(), None::<&str>) {
        log::warn!("could not show logs: {err}");
    }
}

#[tauri::command]
pub fn show_logs_folder(app: AppHandle) {
    show_logs(&app);
}

// ─── Menus ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopupItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub separator: bool,
    pub checked: Option<bool>,
}

fn default_true() -> bool {
    true
}

/// Shows a native context menu built by the frontend. The chosen item comes
/// back as a `context-menu` event with the same token.
#[tauri::command]
pub fn popup_menu(
    app: AppHandle,
    window: WebviewWindow,
    token: String,
    items: Vec<PopupItem>,
) -> Result<(), String> {
    let menu = Menu::new(&app).map_err(|e| e.to_string())?;
    let label = window.label().to_string();
    for item in items {
        let id = format!("ctx:{label}:{token}:{}", item.id);
        if item.separator {
            let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
            menu.append(&sep).map_err(|e| e.to_string())?;
        } else if let Some(checked) = item.checked {
            let entry = CheckMenuItem::with_id(&app, id, &item.label, item.enabled, checked, None::<&str>)
                .map_err(|e| e.to_string())?;
            menu.append(&entry).map_err(|e| e.to_string())?;
        } else {
            let entry = MenuItem::with_id(&app, id, &item.label, item.enabled, None::<&str>)
                .map_err(|e| e.to_string())?;
            menu.append(&entry).map_err(|e| e.to_string())?;
        }
    }
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// ⌘-click on a tab: the document's path as a native menu (like the
/// title-bar proxy icon). Choosing an item reveals it in Finder.
#[tauri::command]
pub fn popup_path_menu(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !app.state::<Access>().can_read(&p) {
        return Err("not allowed".into());
    }
    let mut components: Vec<PathBuf> = p.ancestors().map(Path::to_path_buf).collect();
    components.retain(|c| !c.as_os_str().is_empty());
    let token = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let menu = Menu::new(&app).map_err(|e| e.to_string())?;
    for (index, component) in components.iter().enumerate() {
        let name = if component.parent().is_none() {
            volume_name()
        } else {
            paths::display_name(component)
        };
        let icon = macos::file_icon_rgba(component, 32)
            .map(|(rgba, w, h)| tauri::image::Image::new_owned(rgba, w, h));
        let entry = IconMenuItem::with_id(
            &app,
            format!("pathmenu:{token}:{index}"),
            name,
            true,
            icon,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        menu.append(&entry).map_err(|e| e.to_string())?;
    }
    for c in &components {
        app.state::<Access>().grant_reveal(c);
    }
    app.state::<PathMenus>().0.lock().insert(token, components);
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

fn volume_name() -> String {
    if cfg!(target_os = "macos") {
        "Macintosh HD".into()
    } else {
        "/".into()
    }
}

/// Handles a click in a ⌘-click path menu: the file itself is revealed; a
/// folder opens in Finder with the previous component selected.
pub fn handle_path_menu(app: &AppHandle, token: &str, index: usize) {
    let components = app.state::<PathMenus>().0.lock().remove(token);
    let Some(components) = components else { return };
    let target = if index == 0 {
        components.first()
    } else {
        components.get(index - 1)
    };
    if let Some(t) = target {
        reveal_path(app, t);
    }
}

pub fn handle_context_menu(app: &AppHandle, rest: &str) {
    // rest = "<label>:<token>:<item>"
    let mut parts = rest.splitn(3, ':');
    let (Some(label), Some(token), Some(item)) = (parts.next(), parts.next(), parts.next()) else {
        return;
    };
    let _ = app.emit_to(label, "context-menu", json!({ "token": token, "item": item }));
}

// ─── Print, export, clipboard ──────────────────────────────────────────────

#[tauri::command]
pub fn print_window(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_html(
    app: AppHandle,
    html: String,
    suggested_name: String,
    directory: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_title("Export as HTML")
        .set_file_name(&suggested_name)
        .add_filter("HTML", &["html"]);
    if let Some(dir) = directory.map(PathBuf::from).filter(|d| d.is_dir()) {
        builder = builder.set_directory(dir);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(target) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::write(&target, html).map_err(|e| e.to_string())?;
    Ok(Some(paths::to_string(&target)))
}

#[tauri::command]
pub fn copy_to_clipboard(app: AppHandle, text: String, html: Option<String>) {
    macos::copy_to_pasteboard(&app, text, html);
}

// ─── Settings, recents, themes ─────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    app.state::<SettingsState>().get()
}

#[tauri::command]
pub fn update_settings(app: AppHandle, patch: Value) -> Settings {
    let next = app.state::<SettingsState>().update(&patch);
    crate::settings::broadcast(&app, &next);
    next
}

#[tauri::command]
pub fn reset_settings(app: AppHandle) -> Settings {
    let next = app.state::<SettingsState>().reset();
    crate::settings::broadcast(&app, &next);
    next
}

#[tauri::command]
pub fn get_recents(app: AppHandle) -> Vec<RecentItem> {
    app.state::<Recents>().items()
}

#[tauri::command]
pub fn clear_recents(app: AppHandle) {
    crate::recents::clear(&app);
}

#[tauri::command]
pub fn get_reading_position(app: AppHandle, path: String) -> Option<ReadingPosition> {
    app.state::<Recents>().position(&path)
}

#[tauri::command]
pub fn save_reading_position(app: AppHandle, position: ReadingPosition) {
    if paths::is_stdin_temp(Path::new(&position.path)) {
        return;
    }
    app.state::<Recents>().save_position(position);
}

#[tauri::command]
pub fn list_themes(app: AppHandle) -> Vec<CustomTheme> {
    themes::list(&app)
}

#[tauri::command]
pub fn open_themes_folder(app: AppHandle) {
    themes::reveal_folder(&app);
}

// ─── Default app, CLI ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn default_app_status() -> DefaultAppStatus {
    tauri::async_runtime::spawn_blocking(macos::default_app_status)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn make_default_app(app: AppHandle) -> Result<DefaultAppStatus, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    macos::make_default_app(Box::new(move |r| {
        let _ = tx.send(r);
    }));
    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .unwrap_or_else(|_| Err("Timed out waiting for macOS.".into()))
    })
    .await
    .map_err(|e| e.to_string())?;
    app.state::<SettingsState>()
        .set_internal(|s| s.default_app_banner_shown = true);
    result?;
    Ok(tauri::async_runtime::spawn_blocking(macos::default_app_status)
        .await
        .unwrap_or_default())
}

#[tauri::command]
pub fn dismiss_default_app_banner(app: AppHandle) {
    app.state::<SettingsState>()
        .set_internal(|s| s.default_app_banner_shown = true);
}

#[tauri::command]
pub async fn install_cli(app: AppHandle) -> cli_install::CliInstallResult {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || cli_install::install(&handle))
        .await
        .unwrap_or(cli_install::CliInstallResult {
            ok: false,
            path: None,
            message: "Installation failed.".into(),
        })
}
