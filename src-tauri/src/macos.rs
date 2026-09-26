//! AppKit glue via objc2, only where Tauri has no API. Every function has a
//! portable fallback so the app also builds and runs on Linux for testing.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, WebviewWindow};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TypeStatus {
    pub uti: String,
    pub extensions: Vec<String>,
    /// Display name of the current default app, if any.
    pub handler: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppStatus {
    /// False when running unbundled (dev builds) or off macOS.
    pub supported: bool,
    pub is_default: bool,
    pub types: Vec<TypeStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum DoubleClickAction {
    Zoom,
    Minimize,
    Fill,
    None,
}

/// Parses `AppleActionOnDoubleClick` (plus the legacy
/// `AppleMiniaturizeOnDoubleClick` flag).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_double_click(action: Option<&str>, legacy_minimize: bool) -> DoubleClickAction {
    match action {
        Some("Minimize") => DoubleClickAction::Minimize,
        Some("None") => DoubleClickAction::None,
        Some("Fill") => DoubleClickAction::Fill,
        Some(_) => DoubleClickAction::Zoom,
        None if legacy_minimize => DoubleClickAction::Minimize,
        None => DoubleClickAction::Zoom,
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageRep, NSDeviceRGBColorSpace, NSDocumentController, NSGraphicsContext,
        NSModalResponse, NSModalResponseOK, NSOpenPanel, NSPasteboard, NSPasteboardTypeHTML,
        NSPasteboardTypeString, NSWindow, NSWindowButton, NSWindowStyleMask, NSWorkspace,
    };
    use objc2_foundation::{
        ns_string, NSArray, NSBundle, NSError, NSFileManager, NSPoint, NSRect, NSSize, NSString,
        NSURL, NSUserDefaults,
    };
    use objc2_uniform_type_identifiers::UTType;
    use parking_lot::Mutex;
    use std::sync::{Arc, OnceLock};

    static TRAFFIC_LIGHTS: OnceLock<(f64, f64)> = OnceLock::new();

    fn file_url(path: &Path) -> Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    fn url_path(url: &NSURL) -> Option<PathBuf> {
        url.path().map(|p| PathBuf::from(p.to_string()))
    }

    /// Must run on the main thread (called from `setup`).
    pub fn init(_app: &AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // Folio has its own tabs: no native window tabbing (and no "Show Tab
        // Bar" / "Merge All Windows" items added by AppKit).
        NSWindow::setAllowsAutomaticWindowTabbing(false, mtm);
        let mask = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Miniaturizable
            | NSWindowStyleMask::Resizable;
        let content = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
        let frame = NSWindow::frameRectForContentRect_styleMask(content, mask, mtm);
        let titlebar = frame.size.height - content.size.height;
        let button = NSWindow::standardWindowButton_forStyleMask(
            NSWindowButton::CloseButton,
            mask,
            mtm,
        );
        if let Some(button) = button {
            let h = button.frame().size.height;
            // AppKit centers the buttons in the default titlebar. Tauri keeps
            // their bottom offset and grows the titlebar container to
            // `h + y`, so the button center lands at `y - titlebar/2 + h`.
            let toolbar = crate::windows::TOOLBAR_HEIGHT;
            let y = (toolbar / 2.0 + titlebar / 2.0 - h).round();
            let _ = TRAFFIC_LIGHTS.set((16.0, y.max(0.0)));
            log::info!("traffic lights: titlebar {titlebar}, button {h} → inset y {y}");
        }
    }

    pub fn traffic_light_inset(_toolbar: f64) -> (f64, f64) {
        *TRAFFIC_LIGHTS.get().unwrap_or(&(16.0, 20.0))
    }

    pub fn system_is_dark(_app: &AppHandle) -> bool {
        NSUserDefaults::standardUserDefaults()
            .stringForKey(ns_string!("AppleInterfaceStyle"))
            .is_some_and(|s| s.to_string().eq_ignore_ascii_case("dark"))
    }

    pub fn quit_always_keeps_windows() -> bool {
        NSUserDefaults::standardUserDefaults().boolForKey(ns_string!("NSQuitAlwaysKeepsWindows"))
    }

    pub fn double_click_action() -> DoubleClickAction {
        let defaults = NSUserDefaults::standardUserDefaults();
        let action = defaults
            .stringForKey(ns_string!("AppleActionOnDoubleClick"))
            .map(|s| s.to_string());
        let legacy = defaults.boolForKey(ns_string!("AppleMiniaturizeOnDoubleClick"));
        parse_double_click(action.as_deref(), legacy)
    }

    pub fn perform_double_click(window: &WebviewWindow) {
        let action = double_click_action();
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(ptr) = w.ns_window() else { return };
            // SAFETY: Tauri returns a valid NSWindow pointer for this window,
            // and we're on the main thread.
            let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            match action {
                DoubleClickAction::Zoom => ns_window.zoom(None),
                DoubleClickAction::Minimize => ns_window.miniaturize(None),
                DoubleClickAction::Fill => {
                    if let Some(screen) = ns_window.screen() {
                        ns_window.setFrame_display_animate(screen.visibleFrame(), true, true);
                    }
                }
                DoubleClickAction::None => {}
            }
        });
    }

    pub fn note_recent_document(app: &AppHandle, path: &Path) {
        let path = path.to_path_buf();
        let _ = app.run_on_main_thread(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                NSDocumentController::sharedDocumentController(mtm)
                    .noteNewRecentDocumentURL(&file_url(&path));
            }
        });
    }

    pub fn clear_recent_documents(app: &AppHandle) {
        let _ = app.run_on_main_thread(|| {
            if let Some(mtm) = MainThreadMarker::new() {
                // SAFETY: `nil` is a valid sender.
                unsafe { NSDocumentController::sharedDocumentController(mtm).clearRecentDocuments(None) };
            }
        });
    }

    pub fn copy_to_pasteboard(app: &AppHandle, text: String, html: Option<String>) {
        let _ = app.run_on_main_thread(move || {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            // SAFETY: the pasteboard type statics are provided by AppKit.
            unsafe {
                pb.setString_forType(&NSString::from_str(&text), NSPasteboardTypeString);
                if let Some(html) = html {
                    pb.setString_forType(&NSString::from_str(&html), NSPasteboardTypeHTML);
                }
            }
        });
    }

    fn markdown_types() -> Vec<Retained<UTType>> {
        let mut out: Vec<Retained<UTType>> = Vec::new();
        for ext in crate::paths::MARKDOWN_EXTENSIONS {
            if let Some(t) = UTType::typeWithFilenameExtension(&NSString::from_str(ext)) {
                if !out.iter().any(|o| o.identifier() == t.identifier()) {
                    out.push(t);
                }
            }
        }
        if let Some(t) = UTType::typeWithIdentifier(ns_string!("net.daringfireball.markdown")) {
            if !out.iter().any(|o| o.identifier() == t.identifier()) {
                out.push(t);
            }
        }
        out
    }

    /// Native open panel that accepts Markdown files and folders together.
    pub fn show_open_panel(
        app: &AppHandle,
        directory: Option<PathBuf>,
        folders_only: bool,
        done: Box<dyn FnOnce(Vec<PathBuf>) + Send>,
    ) {
        let _ = app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else { return };
            let panel = NSOpenPanel::openPanel(mtm);
            panel.setCanChooseFiles(!folders_only);
            panel.setCanChooseDirectories(true);
            panel.setAllowsMultipleSelection(true);
            if folders_only {
                panel.setPrompt(Some(ns_string!("Open Folder")));
            }
            let mut types = if folders_only { Vec::new() } else { markdown_types() };
            if let Some(folder) = UTType::typeWithIdentifier(ns_string!("public.folder")) {
                types.push(folder);
            }
            let refs: Vec<&UTType> = types.iter().map(|t| &**t).collect();
            panel.setAllowedContentTypes(&NSArray::from_slice(&refs));
            if let Some(dir) = directory {
                panel.setDirectoryURL(Some(&file_url(&dir)));
            }
            let done = Mutex::new(Some(done));
            let panel_ref = panel.clone();
            let handler = RcBlock::new(move |response: NSModalResponse| {
                let chosen: Vec<PathBuf> = if response == NSModalResponseOK {
                    panel_ref.URLs().iter().filter_map(|u| url_path(&u)).collect()
                } else {
                    Vec::new()
                };
                if let Some(cb) = done.lock().take() {
                    cb(chosen);
                }
            });
            panel.beginWithCompletionHandler(&handler);
        });
    }

    fn app_display_name(url: &NSURL) -> Option<String> {
        url_path(url).and_then(|p| {
            p.file_stem().map(|s| s.to_string_lossy().into_owned())
        })
    }

    fn own_bundle() -> (Retained<NSURL>, Option<String>) {
        let bundle = NSBundle::mainBundle();
        (bundle.bundleURL(), bundle.bundleIdentifier().map(|s| s.to_string()))
    }

    fn bundle_id_of(url: &NSURL) -> Option<String> {
        NSBundle::bundleWithURL(url).and_then(|b| b.bundleIdentifier()).map(|s| s.to_string())
    }

    pub fn default_app_status() -> DefaultAppStatus {
        let (own_url, own_id) = own_bundle();
        let supported = url_path(&own_url)
            .is_some_and(|p| p.extension().is_some_and(|e| e == "app"));
        let workspace = NSWorkspace::sharedWorkspace();
        let mut types = Vec::new();
        for t in markdown_types() {
            let uti = t.identifier().to_string();
            let extensions: Vec<String> = crate::paths::MARKDOWN_EXTENSIONS
                .iter()
                .filter(|ext| {
                    UTType::typeWithFilenameExtension(&NSString::from_str(ext))
                        .is_some_and(|x| x.identifier().to_string() == uti)
                })
                .map(|s| s.to_string())
                .collect();
            let handler_url = workspace.URLForApplicationToOpenContentType(&t);
            let is_default = match (&handler_url, &own_id) {
                (Some(url), Some(id)) => bundle_id_of(url).as_deref() == Some(id.as_str()),
                _ => false,
            };
            types.push(TypeStatus {
                uti,
                extensions,
                handler: handler_url.as_deref().and_then(app_display_name),
                is_default,
            });
        }
        // What matters to users is .md and .markdown.
        let is_default = types
            .iter()
            .filter(|t| t.extensions.iter().any(|e| e == "md" || e == "markdown"))
            .all(|t| t.is_default);
        DefaultAppStatus {
            supported,
            is_default: supported && is_default,
            types,
        }
    }

    pub fn make_default_app(done: Box<dyn FnOnce(Result<(), String>) + Send>) {
        let (own_url, _) = own_bundle();
        let types = markdown_types();
        if types.is_empty() {
            done(Err("No Markdown content types are registered on this Mac.".into()));
            return;
        }
        let remaining = Arc::new(Mutex::new(types.len()));
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let done = Arc::new(Mutex::new(Some(done)));
        let workspace = NSWorkspace::sharedWorkspace();
        for t in types {
            let remaining = remaining.clone();
            let errors = errors.clone();
            let done = done.clone();
            let uti = t.identifier().to_string();
            let handler = RcBlock::new(move |err: *mut NSError| {
                if !err.is_null() {
                    // SAFETY: AppKit passes a valid NSError or nil.
                    let message = unsafe { (*err).localizedDescription().to_string() };
                    errors.lock().push(format!("{uti}: {message}"));
                }
                let mut left = remaining.lock();
                *left -= 1;
                if *left == 0 {
                    if let Some(cb) = done.lock().take() {
                        let errs = errors.lock().clone();
                        cb(if errs.is_empty() { Ok(()) } else { Err(errs.join("\n")) });
                    }
                }
            });
            workspace.setDefaultApplicationAtURL_toOpenContentType_completionHandler(
                &own_url,
                &t,
                Some(&handler),
            );
        }
    }

    pub fn app_path_for_bundle_id(id: &str) -> Option<PathBuf> {
        NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(id))
            .and_then(|u| url_path(&u))
    }

    pub fn start_downloading(path: &Path) {
        let url = file_url(path);
        if let Err(err) = NSFileManager::defaultManager().startDownloadingUbiquitousItemAtURL_error(&url) {
            log::warn!("iCloud download request failed: {}", err.localizedDescription());
        }
    }

    /// RGBA pixels (straight alpha) of the Finder icon for `path`.
    pub fn file_icon_rgba(path: &Path, size: u32) -> Option<(Vec<u8>, u32, u32)> {
        let image = NSWorkspace::sharedWorkspace()
            .iconForFile(&NSString::from_str(&path.to_string_lossy()));
        let px = size as isize;
        // SAFETY: standard bitmap rep allocation; AppKit owns the buffer.
        let rep = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                px,
                px,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                px * 4,
                32,
            )
        }?;
        let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&ctx));
        image.drawInRect(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(size as f64, size as f64),
        ));
        ctx.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        let data = rep.bitmapData();
        if data.is_null() {
            return None;
        }
        let len = (size * size * 4) as usize;
        // SAFETY: the rep owns `len` bytes of pixel data.
        let mut rgba = unsafe { std::slice::from_raw_parts(data, len) }.to_vec();
        // AppKit bitmaps are premultiplied; menus expect straight alpha.
        for px in rgba.chunks_exact_mut(4) {
            let a = px[3] as u32;
            if a > 0 && a < 255 {
                for c in &mut px[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        Some((rgba, size, size))
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn init(_app: &AppHandle) {}
    pub fn traffic_light_inset(_toolbar: f64) -> (f64, f64) {
        (16.0, 20.0)
    }
    pub fn system_is_dark(_app: &AppHandle) -> bool {
        false
    }
    pub fn quit_always_keeps_windows() -> bool {
        false
    }
    pub fn perform_double_click(window: &WebviewWindow) {
        let _ = if window.is_maximized().unwrap_or(false) {
            window.unmaximize()
        } else {
            window.maximize()
        };
    }
    pub fn note_recent_document(_app: &AppHandle, _path: &Path) {}
    pub fn clear_recent_documents(_app: &AppHandle) {}
    pub fn copy_to_pasteboard(_app: &AppHandle, text: String, _html: Option<String>) {
        // Best effort for development on Linux.
        use std::io::Write;
        if let Ok(mut child) = std::process::Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
    pub fn show_open_panel(
        app: &AppHandle,
        directory: Option<PathBuf>,
        folders_only: bool,
        done: Box<dyn FnOnce(Vec<PathBuf>) + Send>,
    ) {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = app.dialog().file();
        if let Some(dir) = directory {
            builder = builder.set_directory(dir);
        }
        let collect = |files: Option<Vec<tauri_plugin_dialog::FilePath>>| -> Vec<PathBuf> {
            files
                .unwrap_or_default()
                .into_iter()
                .filter_map(|f| f.into_path().ok())
                .collect()
        };
        if folders_only {
            builder.pick_folders(move |files| done(collect(files)));
        } else {
            builder
                .add_filter("Markdown", crate::paths::MARKDOWN_EXTENSIONS)
                .pick_files(move |files| done(collect(files)));
        }
    }
    pub fn default_app_status() -> DefaultAppStatus {
        DefaultAppStatus::default()
    }
    pub fn make_default_app(done: Box<dyn FnOnce(Result<(), String>) + Send>) {
        done(Err("Setting the default app is only available on macOS.".into()));
    }
    pub fn app_path_for_bundle_id(_id: &str) -> Option<PathBuf> {
        None
    }
    pub fn start_downloading(_path: &Path) {}
    pub fn file_icon_rgba(_path: &Path, _size: u32) -> Option<(Vec<u8>, u32, u32)> {
        None
    }
}

pub use imp::*;

/// Whether `path` is on a network volume (where FSEvents/inotify are
/// unreliable and the watcher falls back to polling).
pub fn is_network_volume(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: valid C string and a zeroed out-parameter.
    if unsafe { libc::statfs(c_path.as_ptr(), &mut stat) } != 0 {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        let name: String = stat
            .f_fstypename
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| *c as u8 as char)
            .collect();
        matches!(
            name.as_str(),
            "smbfs" | "afpfs" | "nfs" | "webdav" | "cifs" | "ftp" | "macfuse" | "osxfuse"
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        const NFS: i64 = 0x6969;
        const SMB: i64 = 0x517B;
        const CIFS: i64 = 0xFF53_4D42;
        const SMB2: i64 = 0xFE53_4D42;
        const FUSE: i64 = 0x6573_5546;
        let t = stat.f_type as i64;
        matches!(t, NFS | SMB | CIFS | SMB2 | FUSE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_click_parsing() {
        assert_eq!(parse_double_click(Some("Maximize"), false), DoubleClickAction::Zoom);
        assert_eq!(parse_double_click(Some("Minimize"), false), DoubleClickAction::Minimize);
        assert_eq!(parse_double_click(Some("None"), true), DoubleClickAction::None);
        assert_eq!(parse_double_click(Some("Fill"), false), DoubleClickAction::Fill);
        assert_eq!(parse_double_click(None, true), DoubleClickAction::Minimize);
        assert_eq!(parse_double_click(None, false), DoubleClickAction::Zoom);
    }

    #[test]
    fn local_tmp_is_not_network() {
        assert!(!is_network_volume(&std::env::temp_dir()));
    }
}
