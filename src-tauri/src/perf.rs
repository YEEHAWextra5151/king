//! Launch and open timing, written to the log as `perf:` lines.
//!
//! `+Nms` is measured from `main`; `wall=` is milliseconds since the Unix
//! epoch, so `scripts/measure-launch.sh` can compare it with the moment it
//! ran `open`. Warm opens are measured from the `Opened` event.

use parking_lot::Mutex;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

static START: OnceLock<Instant> = OnceLock::new();
static LAST_OPEN: Mutex<Option<Instant>> = Mutex::new(None);

pub fn init() {
    let _ = START.get_or_init(Instant::now);
}

pub fn since_start_ms() -> f64 {
    START.get().map(|s| s.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn wall_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Called when an `Opened` event (Finder, CLI) arrives.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn note_open() {
    *LAST_OPEN.lock() = Some(Instant::now());
}

pub fn mark(_app: &AppHandle, name: &str) {
    let since_open = LAST_OPEN
        .lock()
        .map(|t| format!(" open+{:.1}ms", t.elapsed().as_secs_f64() * 1000.0))
        .unwrap_or_default();
    log::info!(
        "perf: {name} +{:.1}ms{since_open} wall={}",
        since_start_ms(),
        wall_ms()
    );
}
