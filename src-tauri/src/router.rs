//! Routes open requests from every source (Finder, CLI, deep links, the open
//! panel, drops, Open Recent) to a window: classify, dedupe against every
//! window's tabs, grant access, note recents, then deliver.

use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::access::Access;
use crate::documents;
use crate::open_queue::{OpenOptions, OpenQueue, OpenRequest, OpenSource, TargetKind, WindowInit};
use crate::paths;
use crate::recents;
use crate::registry::Registry;
use crate::settings::{OpenFilesIn, SettingsState};
use crate::windows;

pub struct Classified {
    pub path: PathBuf,
    pub kind: TargetKind,
}

/// Canonicalizes and classifies a path the user asked to open.
pub fn classify(path: &Path) -> Classified {
    match paths::canonical(path) {
        Some(p) if p.is_dir() => Classified {
            path: p,
            kind: TargetKind::Folder,
        },
        Some(p) => {
            let kind = if paths::is_markdown(&p) {
                TargetKind::Markdown
            } else if paths::is_known_text(&p) || documents::sniff_text(&p) {
                TargetKind::Text
            } else {
                // Unknown binary: still opens (as Markdown) to show a calm
                // "doesn't look like text" state rather than doing nothing.
                TargetKind::Markdown
            };
            Classified { path: p, kind }
        }
        None => {
            // iCloud placeholders don't exist under their real name yet.
            let kind = if documents::icloud_stub_for(path).is_some() && paths::is_markdown(path) {
                TargetKind::Markdown
            } else {
                TargetKind::Missing
            };
            Classified {
                path: paths::normalize_lexically(path),
                kind,
            }
        }
    }
}

/// Entry point for every open. Before `setup` finishes, requests are queued.
pub fn open_paths(app: &AppHandle, paths: Vec<PathBuf>, opts: OpenOptions) {
    if paths.is_empty() {
        return;
    }
    let queue = app.state::<OpenQueue>();
    if !queue.is_ready() {
        queue.push_cold(paths, opts);
        return;
    }
    route(app, paths, opts);
}

fn route(app: &AppHandle, paths: Vec<PathBuf>, opts: OpenOptions) {
    let registry = app.state::<Registry>();
    let access = app.state::<Access>();
    let mut files: Vec<OpenRequest> = Vec::new();
    let mut first = true;

    for raw in paths {
        let target = classify(&raw);
        if target.kind == TargetKind::Folder {
            open_folder(app, &target.path, &opts);
            continue;
        }
        // Already open anywhere (even when dropped onto another window):
        // focus the existing tab instead of duplicating it.
        if let Some((label, tab_id)) = registry.find_path(&target.path) {
            focus_tab(app, &label, &tab_id, &opts);
            continue;
        }
        if target.kind != TargetKind::Missing {
            access.grant_file(&target.path);
            let is_stdin = opts.stdin || paths::is_stdin_temp(&target.path);
            if !is_stdin {
                recents::note(app, &target.path);
            }
        } else {
            // Grant the lexical path so the error tab can re-check it
            // (e.g. after the user restores the file).
            access.grant_file(&target.path);
        }
        let mut req = OpenRequest::new(paths::to_string(&target.path), target.kind);
        req.view = opts.view;
        req.line = opts.line;
        req.is_stdin = opts.stdin || paths::is_stdin_temp(&target.path);
        req.insert_at = opts.insert_at.map(|i| i + files.len());
        req.activate = first;
        first = false;
        files.push(req);
    }

    if !files.is_empty() {
        deliver(app, files, &opts);
    }
}

fn focus_tab(app: &AppHandle, label: &str, tab_id: &str, opts: &OpenOptions) {
    let _ = app.emit_to(
        label,
        "menu-action",
        json!({
            "action": "focus-tab",
            "arg": { "tabId": tab_id, "line": opts.line, "view": opts.view }
        }),
    );
    windows::focus(app, label);
}

/// Picks the target window(s) for new tabs and hands the requests over.
fn deliver(app: &AppHandle, requests: Vec<OpenRequest>, opts: &OpenOptions) {
    let registry = app.state::<Registry>();
    let settings = app.state::<SettingsState>().get();
    let explicit = opts.target_window.clone().filter(|l| registry.snapshot(l).is_some());

    let separate_windows = explicit.is_none()
        && settings.open_files_in == OpenFilesIn::Windows
        && opts.source != OpenSource::Drop;

    if opts.new_window {
        windows::create_document_window(app, WindowInit::default(), requests);
        return;
    }
    if separate_windows {
        for req in requests {
            // Reuse an empty (Welcome-only) frontmost window for the first one.
            if let Some(label) = registry.frontmost().filter(|l| window_is_empty(app, l)) {
                push_to_window(app, &label, vec![req]);
            } else {
                windows::create_document_window(app, WindowInit::default(), vec![req]);
            }
        }
        return;
    }
    match explicit.or_else(|| registry.frontmost()) {
        Some(label) => push_to_window(app, &label, requests),
        None => {
            windows::create_document_window(app, WindowInit::default(), requests);
        }
    }
}

fn window_is_empty(app: &AppHandle, label: &str) -> bool {
    app.state::<Registry>()
        .snapshot(label)
        .is_some_and(|s| s.tabs.iter().all(|t| t.path.is_none()) && s.folder.is_none())
}

pub fn push_to_window(app: &AppHandle, label: &str, requests: Vec<OpenRequest>) {
    app.state::<OpenQueue>().push_for_window(label, requests);
    let _ = app.emit_to(label, "documents-opened", json!({}));
    windows::focus(app, label);
}

fn open_folder(app: &AppHandle, folder: &Path, opts: &OpenOptions) {
    let registry = app.state::<Registry>();
    let access = app.state::<Access>();
    access.grant_dir(folder);
    if opts.source != OpenSource::Session {
        recents::note(app, folder);
    }

    if let Some(label) = registry.window_with_folder(folder) {
        windows::focus(app, &label);
        return;
    }

    let readme = paths::find_readme(folder);
    let mut req = OpenRequest::new(paths::to_string(folder), TargetKind::Folder);
    // Don't auto-open a README that is already open elsewhere.
    req.readme = readme
        .filter(|r| registry.find_path(r).is_none())
        .map(|r| paths::to_string(&r));
    req.view = opts.view;
    req.line = opts.line;

    // A window holds at most one folder: reuse the target/frontmost window
    // only if it has none.
    let candidate = opts
        .target_window
        .clone()
        .or_else(|| registry.frontmost())
        .filter(|l| registry.snapshot(l).is_some_and(|s| s.folder.is_none()));
    match candidate {
        Some(label) if !opts.new_window => push_to_window(app, &label, vec![req]),
        _ => {
            windows::create_document_window(app, WindowInit::default(), vec![req]);
        }
    }
}

/// Opens Folio's bundled help in a tab.
pub fn open_help(app: &AppHandle) {
    let Ok(dir) = app.path().resource_dir() else {
        return;
    };
    let help = dir.join("help.md");
    let mut req = OpenRequest::new(paths::to_string(&help), TargetKind::Markdown);
    req.activate = true;
    if let Some((label, tab_id)) = app.state::<Registry>().find_path(&help) {
        focus_tab(app, &label, &tab_id, &OpenOptions::default());
        return;
    }
    match app.state::<Registry>().frontmost() {
        Some(label) => push_to_window(app, &label, vec![req]),
        None => {
            windows::create_document_window(app, WindowInit::default(), vec![req]);
        }
    }
}
