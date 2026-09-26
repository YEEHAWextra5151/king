//! Folio ▸ Install Command Line Tool… — symlinks `/usr/local/bin/folio` to
//! the script inside the bundle, using the standard administrator prompt when
//! needed (as VS Code does for `code`), and falls back to `~/.local/bin`.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallResult {
    pub ok: bool,
    pub path: Option<String>,
    /// Shown to the user (e.g. PATH instructions for the fallback).
    pub message: String,
}

pub fn script_path(app: &AppHandle) -> Option<PathBuf> {
    let p = app.path().resource_dir().ok()?.join("bin").join("folio");
    p.exists().then_some(p)
}

fn link(source: &Path, target: &Path) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if target.symlink_metadata().is_ok() {
        std::fs::remove_file(target)?;
    }
    std::os::unix::fs::symlink(source, target)
}

/// Single-quotes for /bin/sh.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Escapes for an AppleScript string literal.
fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn install_with_admin_prompt(source: &Path, target: &Path) -> bool {
    let command = format!(
        "mkdir -p /usr/local/bin && ln -sf {} {}",
        sh_quote(&source.to_string_lossy()),
        sh_quote(&target.to_string_lossy())
    );
    let script = format!(
        "do shell script {} with prompt {} with administrator privileges",
        applescript_quote(&command),
        applescript_quote("Folio wants to install the “folio” command in /usr/local/bin.")
    );
    std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn install(app: &AppHandle) -> CliInstallResult {
    let Some(source) = script_path(app) else {
        return CliInstallResult {
            ok: false,
            path: None,
            message: "The folio script wasn't found in the app bundle. Install Folio from its disk image and try again.".into(),
        };
    };
    let system = PathBuf::from("/usr/local/bin/folio");
    if link(&source, &system).is_ok() || (cfg!(target_os = "macos") && install_with_admin_prompt(&source, &system)) {
        return CliInstallResult {
            ok: true,
            path: Some(system.to_string_lossy().into_owned()),
            message: "The folio command is installed. Try `folio README.md` in a new Terminal window.".into(),
        };
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return CliInstallResult {
            ok: false,
            path: None,
            message: "Couldn't install the folio command.".into(),
        };
    };
    let local = home.join(".local/bin/folio");
    match link(&source, &local) {
        Ok(()) => {
            let on_path = std::env::var("PATH")
                .unwrap_or_default()
                .split(':')
                .any(|p| Path::new(p) == local.parent().unwrap_or(Path::new("")));
            let hint = if on_path {
                String::new()
            } else {
                "\n\n~/.local/bin isn't on your PATH yet. Add this line to ~/.zshrc:\n\nexport PATH=\"$HOME/.local/bin:$PATH\"".into()
            };
            CliInstallResult {
                ok: true,
                path: Some(local.to_string_lossy().into_owned()),
                message: format!("The folio command is installed in ~/.local/bin.{hint}"),
            }
        }
        Err(err) => CliInstallResult {
            ok: false,
            path: None,
            message: format!("Couldn't install the folio command: {err}"),
        },
    }
}

/// Menu entry point: installs, then reports with a native alert.
pub fn install_interactive(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = install(&app);
        app.dialog()
            .message(&result.message)
            .title(if result.ok {
                "Command Line Tool Installed"
            } else {
                "Command Line Tool Not Installed"
            })
            .kind(if result.ok {
                MessageDialogKind::Info
            } else {
                MessageDialogKind::Warning
            })
            .show(|_| {});
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(sh_quote("/Apps/It's.app"), r"'/Apps/It'\''s.app'");
        assert_eq!(applescript_quote(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    }

    #[test]
    fn link_replaces_existing() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("folio");
        std::fs::write(&src, "#!/bin/sh").unwrap();
        let target = dir.path().join("bin/folio");
        link(&src, &target).unwrap();
        link(&src, &target).unwrap();
        assert_eq!(std::fs::read_link(&target).unwrap(), src);
    }
}
