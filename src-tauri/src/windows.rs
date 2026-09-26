//! Window creation and native chrome.
//!
//! Windows are created hidden, with the theme's surface color as the native
//! background (wry disables WKWebView's own white background when a
//! background color is set and `macos-private-api` is on). The frontend
//! calls `window_ready` after its first paint, and only then is the window
//! shown: no white flash, no layout shift, and no empty Welcome window when
//! launched with files.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::open_queue::{OpenQueue, OpenRequest, WindowInit};
use crate::registry::Registry;
use crate::settings::{Appearance, Settings, SettingsState};

pub const DEFAULT_WIDTH: f64 = 920.0;
pub const DEFAULT_HEIGHT: f64 = 820.0;
pub const MIN_WIDTH: f64 = 520.0;
pub const MIN_HEIGHT: f64 = 400.0;
pub const TOOLBAR_HEIGHT: f64 = 44.0;
const CASCADE_OFFSET: f64 = 24.0;
const SHOW_FALLBACK: Duration = Duration::from_millis(1500);

pub const SETTINGS_LABEL: &str = "settings";

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Surface colors per built-in theme (light, dark). Custom themes use the
/// base theme's colors for the native background.
fn surface_rgb(theme: &str, dark: bool) -> (u8, u8, u8) {
    match (theme, dark) {
        ("github", false) => (0xFF, 0xFF, 0xFF),
        ("github", true) => (0x0D, 0x11, 0x17),
        ("paper", false) => (0xFF, 0xFF, 0xFF),
        ("paper", true) => (0x00, 0x00, 0x00),
        (_, false) => (0xFA, 0xF9, 0xF5),
        (_, true) => (0x26, 0x26, 0x24),
    }
}

pub fn is_dark(app: &AppHandle, settings: &Settings) -> bool {
    match settings.appearance {
        Appearance::Light => false,
        Appearance::Dark => true,
        Appearance::System => crate::macos::system_is_dark(app),
    }
}

pub fn background_color(app: &AppHandle, settings: &Settings) -> Color {
    let (r, g, b) = surface_rgb(&settings.theme, is_dark(app, settings));
    Color(r, g, b, 255)
}

pub fn forced_theme(settings: &Settings) -> Option<Theme> {
    match settings.appearance {
        Appearance::System => None,
        Appearance::Light => Some(Theme::Light),
        Appearance::Dark => Some(Theme::Dark),
    }
}

/// Re-applies native background color and appearance to every window, so
/// traffic lights, menus, dialogs and `prefers-color-scheme` follow the
/// user's System/Light/Dark choice.
pub fn apply_appearance_to_all(app: &AppHandle, settings: &Settings) {
    let theme = forced_theme(settings);
    for (_, window) in app.webview_windows() {
        let _ = window.set_theme(theme);
        apply_background(app, &window, settings);
    }
}

pub fn apply_background(app: &AppHandle, window: &WebviewWindow, settings: &Settings) {
    let dark = match forced_theme(settings) {
        Some(Theme::Dark) => true,
        Some(_) => false,
        None => window
            .theme()
            .map(|t| t == Theme::Dark)
            .unwrap_or_else(|_| is_dark(app, settings)),
    };
    let (r, g, b) = surface_rgb(&settings.theme, dark);
    let _ = window.set_background_color(Some(Color(r, g, b, 255)));
}

fn dev_origin(app: &AppHandle) -> Option<Url> {
    app.config().build.dev_url.clone()
}

/// Only the app's own origin may load in the webview.
pub fn is_app_url(url: &Url, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || dev.is_some_and(|d| d.origin() == url.origin())
        }
        _ => false,
    }
}

fn external_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn boot_script(app: &AppHandle, label: &str, kind: &str) -> String {
    let settings = app.state::<SettingsState>().get();
    let custom_css = crate::themes::active_theme_css(app, &settings.theme);
    let (tl_x, tl_y) = crate::macos::traffic_light_inset(TOOLBAR_HEIGHT);
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let boot = json!({
        "label": label,
        "kind": kind,
        "platform": platform,
        "version": app.package_info().version.to_string(),
        "settings": settings,
        "customThemeCss": custom_css,
        "trafficLights": { "x": tl_x, "y": tl_y },
        "toolbarHeight": TOOLBAR_HEIGHT,
        // FOLIO_PERF=1 also logs tab switches and live reloads (for
        // scripts/measure-launch.sh); launch and open marks are always on.
        "perf": std::env::var_os("FOLIO_PERF").is_some(),
    });
    // Runs at document start, before any page script: expose the boot data
    // and resolve theme attributes before first paint.
    format!(
        r#"(function(){{
  var b = {boot};
  Object.defineProperty(window, "__FOLIO_BOOT__", {{ value: b, writable: false }});
  var apply = function () {{
    var d = document.documentElement;
    if (!d) return false;
    var s = b.settings;
    d.dataset.platform = b.platform;
    d.dataset.window = b.kind;
    d.dataset.theme = s.theme.indexOf("custom:") === 0 ? "claude" : s.theme;
    d.dataset.font = s.fontFamily;
    d.dataset.width = s.readingWidth;
    return true;
  }};
  if (!apply()) document.addEventListener("readystatechange", apply, {{ once: true }});
}})();"#,
        boot = boot
    )
}

fn next_label() -> String {
    format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::SeqCst))
}

/// Where a new window goes: cascaded from the frontmost window, like AppKit.
fn cascade_frame(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let registry = app.state::<Registry>();
    let label = registry.frontmost()?;
    let window = app.get_webview_window(&label)?;
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    let (mut x, mut y) = (pos.x + CASCADE_OFFSET, pos.y + CASCADE_OFFSET);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        let m_pos = area.position.to_logical::<f64>(scale);
        let m_size = area.size.to_logical::<f64>(scale);
        if x + size.width > m_pos.x + m_size.width || y + size.height > m_pos.y + m_size.height {
            x = m_pos.x + CASCADE_OFFSET;
            y = m_pos.y + CASCADE_OFFSET;
        }
    }
    Some((x, y, size.width, size.height))
}

/// Creates a hidden document window and queues its initial content.
pub fn create_document_window(
    app: &AppHandle,
    init: WindowInit,
    requests: Vec<OpenRequest>,
) -> Option<String> {
    create_document_window_at(app, init, requests, None)
}

pub fn create_document_window_at(
    app: &AppHandle,
    init: WindowInit,
    requests: Vec<OpenRequest>,
    frame: Option<Frame>,
) -> Option<String> {
    let label = next_label();
    let queue = app.state::<OpenQueue>();
    queue.set_init(&label, init);
    queue.push_for_window(&label, requests);
    app.state::<Registry>().add_window(&label);

    let settings = app.state::<SettingsState>().get();
    let (w, h) = settings
        .last_window_size
        .unwrap_or((DEFAULT_WIDTH, DEFAULT_HEIGHT));
    let placement = match frame {
        Some(f) => Some((f.x, f.y, f.width, f.height)),
        None => cascade_frame(app),
    };

    let dev = dev_origin(app);
    let nav_app = app.clone();
    let new_window_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Folio")
        .inner_size(w.max(MIN_WIDTH), h.max(MIN_HEIGHT))
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .visible(false)
        .focused(true)
        .accept_first_mouse(true)
        .background_color(background_color(app, &settings))
        .theme(forced_theme(&settings))
        .initialization_script(boot_script(app, &label, "document"))
        .on_navigation(move |url| {
            if is_app_url(url, dev.as_ref()) {
                return true;
            }
            log::warn!("blocked navigation to {url}");
            // A blocked http(s)/mailto navigation can only come from a user
            // gesture (documents run no scripts), e.g. WebKit's own "Open
            // Link" item: honor the intent in the default browser.
            if external_allowed(url) {
                crate::commands::open_external_url(&nav_app, url.as_str());
            }
            false
        })
        .on_new_window(move |url, _features| {
            log::warn!("blocked new window for {url}");
            if external_allowed(&url) {
                crate::commands::open_external_url(&new_window_app, url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_download(|_, _| false);

    builder = match placement {
        Some((x, y, pw, ph)) => builder.position(x, y).inner_size(pw, ph),
        None => builder.center(),
    };

    #[cfg(target_os = "macos")]
    {
        let (tl_x, tl_y) = crate::macos::traffic_light_inset(TOOLBAR_HEIGHT);
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(tl_x, tl_y))
            .allow_link_preview(false);
    }

    match builder.build() {
        Ok(window) => {
            crate::perf::mark(app, "window-created");
            schedule_show_fallback(app, &label);
            let _ = window;
            Some(label)
        }
        Err(err) => {
            log::error!("could not create window: {err}");
            app.state::<Registry>().remove_window(&label);
            queue.forget_window(&label);
            None
        }
    }
}

/// Shows the window even if the frontend never reports its first paint.
fn schedule_show_fallback(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_FALLBACK);
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = inner.get_webview_window(&label) {
                if !w.is_visible().unwrap_or(true) {
                    log::warn!("{label}: first paint not reported in time; showing anyway");
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
    });
}

/// Called by the frontend after its first paint.
pub fn reveal(window: &WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
    let _ = window.set_focus();
}

/// Brings a window to the front (unminimizing it) if it exists.
pub fn focus(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        // Hidden windows are still waiting for first paint; `window_ready`
        // will show and focus them.
        if w.is_visible().unwrap_or(false) {
            let _ = w.set_focus();
        }
    }
}

pub fn create_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let settings = app.state::<SettingsState>().get();
    let dev = dev_origin(app);
    #[allow(unused_mut)]
    let mut builder =
        WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("index.html".into()))
            .title("Settings")
            .inner_size(620.0, 460.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(true)
            .visible(false)
            .center()
            .background_color(background_color(app, &settings))
            .theme(forced_theme(&settings))
            .initialization_script(boot_script(app, SETTINGS_LABEL, "settings"))
            .on_navigation(move |url| is_app_url(url, dev.as_ref()))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false);
    #[cfg(target_os = "macos")]
    {
        builder = builder.allow_link_preview(false);
    }
    match builder.build() {
        Ok(_) => schedule_show_fallback(app, SETTINGS_LABEL),
        Err(err) => log::error!("could not create settings window: {err}"),
    }
}

pub fn document_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("doc-"))
        .map(|(_, w)| w)
        .collect()
}

pub fn frame_of(window: &WebviewWindow) -> Option<Frame> {
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Frame {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_origin_checks() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        let ok = |s: &str| is_app_url(&Url::parse(s).unwrap(), Some(&dev));
        assert!(ok("tauri://localhost/index.html"));
        assert!(ok("http://tauri.localhost/index.html"));
        assert!(ok("http://localhost:1420/src/main.tsx"));
        assert!(!ok("http://localhost:1421/"));
        assert!(!ok("https://example.com/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("tauri://evil/"));
    }

    #[test]
    fn surface_colors_match_tokens() {
        assert_eq!(surface_rgb("claude", false), (0xFA, 0xF9, 0xF5));
        assert_eq!(surface_rgb("claude", true), (0x26, 0x26, 0x24));
        assert_eq!(surface_rgb("custom:mine", true), (0x26, 0x26, 0x24));
    }
}
