//! Live reload.
//!
//! Each open file is watched through its *parent directory*, so atomic saves
//! (write a temp file, rename it over the original, as vim and VS Code do)
//! are caught: the file's inode changes but the directory entry doesn't.
//! Directory watches are refcounted and shared by every tab and window.
//! After the ~100 ms debounce, the file is re-stat'ed and compared with the
//! last known (mtime, size, existence), so a burst of events produces one
//! `document-changed` or `document-removed`. Network volumes use a polling
//! watcher, and every file is re-checked when the app becomes active.

use notify_debouncer_full::notify::{self, PollWatcher, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, new_debouncer_opt, DebounceEventResult, Debouncer, NoCache, RecommendedCache,
};
use parking_lot::Mutex;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::documents;
use crate::registry::Registry;

const DEBOUNCE: Duration = Duration::from_millis(100);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq)]
struct FileState {
    exists: bool,
    modified_ms: f64,
    size: u64,
}

impl FileState {
    fn read(path: &Path) -> Self {
        match std::fs::metadata(path) {
            Ok(meta) => FileState {
                exists: true,
                modified_ms: documents::modified_ms(&meta),
                size: meta.len(),
            },
            Err(_) => FileState {
                exists: false,
                modified_ms: 0.0,
                size: 0,
            },
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Change {
    Modified,
    Removed,
    Restored,
}

fn classify(before: FileState, after: FileState) -> Option<Change> {
    match (before.exists, after.exists) {
        (true, false) => Some(Change::Removed),
        (false, true) => Some(Change::Restored),
        (true, true) if before != after => Some(Change::Modified),
        _ => None,
    }
}

struct WatchedFile {
    dir: PathBuf,
    state: FileState,
}

#[derive(Default)]
struct Inner {
    native: Option<Debouncer<RecommendedWatcher, RecommendedCache>>,
    poll: Option<Debouncer<PollWatcher, NoCache>>,
    files: HashMap<PathBuf, WatchedFile>,
    /// dir → (refcount, polled)
    dirs: HashMap<PathBuf, (usize, bool)>,
}

#[derive(Default)]
pub struct Watcher {
    inner: Mutex<Inner>,
}

impl Watcher {
    pub fn start(&self, app: &AppHandle) {
        let mut inner = self.inner.lock();
        let handle = app.clone();
        match new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
            on_events(&handle, res)
        }) {
            Ok(d) => inner.native = Some(d),
            Err(err) => log::error!("file watcher unavailable: {err}"),
        }
        let handle = app.clone();
        let config = notify::Config::default().with_poll_interval(POLL_INTERVAL);
        match new_debouncer_opt::<_, PollWatcher, NoCache>(
            DEBOUNCE,
            None,
            move |res: DebounceEventResult| on_events(&handle, res),
            NoCache,
            config,
        ) {
            Ok(d) => inner.poll = Some(d),
            Err(err) => log::error!("polling watcher unavailable: {err}"),
        }
    }

    /// Makes the watched set equal to `paths` (every file open in any tab).
    pub fn sync(&self, paths: &[String]) {
        let wanted: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let mut inner = self.inner.lock();
        let stale: Vec<PathBuf> = inner
            .files
            .keys()
            .filter(|p| !wanted.contains(*p))
            .cloned()
            .collect();
        for path in stale {
            if let Some(file) = inner.files.remove(&path) {
                release_dir(&mut inner, &file.dir);
            }
        }
        for path in wanted {
            if inner.files.contains_key(&path) {
                continue;
            }
            let Some(dir) = path.parent().map(Path::to_path_buf) else {
                continue;
            };
            let state = FileState::read(&path);
            retain_dir(&mut inner, &dir);
            inner.files.insert(path, WatchedFile { dir, state });
        }
    }

    /// Checks the given paths now, returning the ones that changed.
    fn check(&self, candidates: &[PathBuf]) -> Vec<(PathBuf, Change, f64)> {
        let mut inner = self.inner.lock();
        let mut out = Vec::new();
        for path in candidates {
            if let Some(file) = inner.files.get_mut(path) {
                let now = FileState::read(path);
                if let Some(change) = classify(file.state, now) {
                    file.state = now;
                    out.push((path.clone(), change, now.modified_ms));
                }
            }
        }
        out
    }

    fn files_in(&self, dir: &Path) -> Vec<PathBuf> {
        self.inner
            .lock()
            .files
            .iter()
            .filter(|(_, f)| f.dir == dir)
            .map(|(p, _)| p.clone())
            .collect()
    }

    fn all_files(&self) -> Vec<PathBuf> {
        self.inner.lock().files.keys().cloned().collect()
    }

    fn is_watched(&self, path: &Path) -> bool {
        self.inner.lock().files.contains_key(path)
    }

    fn is_watched_dir(&self, path: &Path) -> bool {
        self.inner.lock().dirs.contains_key(path)
    }
}

fn retain_dir(inner: &mut Inner, dir: &Path) {
    if let Some((count, _)) = inner.dirs.get_mut(dir) {
        *count += 1;
        return;
    }
    let polled = crate::macos::is_network_volume(dir);
    let result = if polled {
        inner
            .poll
            .as_mut()
            .map(|d| d.watch(dir, RecursiveMode::NonRecursive))
    } else {
        inner
            .native
            .as_mut()
            .map(|d| d.watch(dir, RecursiveMode::NonRecursive))
    };
    if let Some(Err(err)) = result {
        log::warn!("could not watch {}: {err}", dir.display());
    }
    inner.dirs.insert(dir.to_path_buf(), (1, polled));
}

fn release_dir(inner: &mut Inner, dir: &Path) {
    let Some((count, polled)) = inner.dirs.get_mut(dir) else {
        return;
    };
    *count -= 1;
    if *count > 0 {
        return;
    }
    let polled = *polled;
    inner.dirs.remove(dir);
    let _ = if polled {
        inner.poll.as_mut().map(|d| d.unwatch(dir))
    } else {
        inner.native.as_mut().map(|d| d.unwatch(dir))
    };
}

fn on_events(app: &AppHandle, result: DebounceEventResult) {
    let watcher = app.state::<Watcher>();
    let events = match result {
        Ok(events) => events,
        Err(errors) => {
            for e in errors {
                log::warn!("watch error: {e}");
            }
            // Re-check everything; we may have missed something.
            let all = watcher.all_files();
            emit_changes(app, watcher.check(&all));
            return;
        }
    };
    let mut candidates: HashSet<PathBuf> = HashSet::new();
    for event in events {
        if event.need_rescan() {
            candidates.extend(watcher.all_files());
            continue;
        }
        for path in &event.paths {
            if watcher.is_watched(path) {
                candidates.insert(path.clone());
            } else if watcher.is_watched_dir(path) {
                candidates.extend(watcher.files_in(path));
            } else if let Some(parent) = path.parent() {
                // Renames of other entries (e.g. `file.tmp` → `file`) are
                // reported under the temp name on some platforms.
                if watcher.is_watched_dir(parent) {
                    candidates.extend(watcher.files_in(parent));
                }
            }
        }
    }
    let candidates: Vec<PathBuf> = candidates.into_iter().collect();
    emit_changes(app, watcher.check(&candidates));
}

fn emit_changes(app: &AppHandle, changes: Vec<(PathBuf, Change, f64)>) {
    let registry = app.state::<Registry>();
    for (path, change, modified_ms) in changes {
        let path_str = path.to_string_lossy().into_owned();
        let (event, payload) = match change {
            Change::Modified | Change::Restored => (
                "document-changed",
                json!({ "path": path_str, "modifiedMs": modified_ms }),
            ),
            Change::Removed => ("document-removed", json!({ "path": path_str })),
        };
        log::debug!("{event}: {path_str}");
        for label in registry.windows_showing(&path_str) {
            let _ = app.emit_to(label.as_str(), event, payload.clone());
        }
    }
}

/// Re-checks every watched file (called when the app becomes active, since
/// events can be missed while asleep or on some volumes).
pub fn recheck_all(app: &AppHandle) {
    let watcher = app.state::<Watcher>();
    let all = watcher.all_files();
    emit_changes(app, watcher.check(&all));
}

/// Tells the frontend that a file finished downloading from iCloud.
pub fn notify_ready(app: &AppHandle, path: &Path) {
    let path_str = path.to_string_lossy().into_owned();
    let modified = std::fs::metadata(path)
        .map(|m| documents::modified_ms(&m))
        .unwrap_or(0.0);
    let payload = json!({ "path": path_str, "modifiedMs": modified });
    for label in app.state::<Registry>().windows_showing(&path_str) {
        let _ = app.emit_to(label.as_str(), "document-changed", payload.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(exists: bool, m: f64, size: u64) -> FileState {
        FileState {
            exists,
            modified_ms: m,
            size,
        }
    }

    #[test]
    fn change_classification() {
        assert_eq!(classify(st(true, 1.0, 5), st(true, 2.0, 5)), Some(Change::Modified));
        assert_eq!(classify(st(true, 1.0, 5), st(true, 1.0, 6)), Some(Change::Modified));
        assert_eq!(classify(st(true, 1.0, 5), st(true, 1.0, 5)), None);
        assert_eq!(classify(st(true, 1.0, 5), st(false, 0.0, 0)), Some(Change::Removed));
        assert_eq!(classify(st(false, 0.0, 0), st(true, 3.0, 1)), Some(Change::Restored));
        assert_eq!(classify(st(false, 0.0, 0), st(false, 0.0, 0)), None);
    }

    #[test]
    fn sync_refcounts_directories() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let w = Watcher::default();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        w.sync(&[s(&a), s(&b)]);
        assert_eq!(w.inner.lock().dirs.get(dir.path()).map(|d| d.0), Some(2));
        w.sync(&[s(&a)]);
        assert_eq!(w.inner.lock().dirs.get(dir.path()).map(|d| d.0), Some(1));
        w.sync(&[]);
        assert!(w.inner.lock().dirs.is_empty());
    }

    #[test]
    fn atomic_save_is_detected_as_modification() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        std::fs::write(&a, "one").unwrap();
        let w = Watcher::default();
        w.sync(&[a.to_string_lossy().into_owned()]);
        // Write-temp-then-rename, like vim and VS Code.
        let tmp = dir.path().join(".a.md.swp");
        std::fs::write(&tmp, "two, longer").unwrap();
        std::fs::rename(&tmp, &a).unwrap();
        let changes = w.check(std::slice::from_ref(&a));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].1, Change::Modified);
        std::fs::remove_file(&a).unwrap();
        assert_eq!(w.check(std::slice::from_ref(&a))[0].1, Change::Removed);
        std::fs::write(&a, "back").unwrap();
        assert_eq!(w.check(&[a])[0].1, Change::Restored);
    }
}
