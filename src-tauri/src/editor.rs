//! Open in Editor. Launches the editor chosen in Settings (or the first
//! installed of a known list) by bundle id, never through the default
//! handler for .md files, which is Folio itself.

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
}

struct Known {
    id: &'static str,
    name: &'static str,
    /// URL that opens a file at a line, handled by the editor itself.
    line_url: Option<&'static str>,
}

const KNOWN: &[Known] = &[
    Known { id: "com.microsoft.VSCode", name: "Visual Studio Code", line_url: Some("vscode://file{path}:{line}") },
    Known { id: "com.todesktop.230313mzl4w4u92", name: "Cursor", line_url: Some("cursor://file{path}:{line}") },
    Known { id: "dev.zed.Zed", name: "Zed", line_url: None },
    Known { id: "com.sublimetext.4", name: "Sublime Text", line_url: None },
    Known { id: "com.sublimetext.3", name: "Sublime Text", line_url: None },
    Known { id: "com.barebones.bbedit", name: "BBEdit", line_url: None },
];

const TEXTEDIT: &str = "com.apple.TextEdit";

/// Characters escaped in the path part of an editor URL.
const PATH_ESCAPES: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'%').add(b'?').add(b'<').add(b'>').add(b'`');

/// Installed editors, in preference order, with TextEdit last.
pub fn installed() -> Vec<EditorInfo> {
    let mut out: Vec<EditorInfo> = KNOWN
        .iter()
        .filter(|k| crate::macos::app_path_for_bundle_id(k.id).is_some())
        .map(|k| EditorInfo { id: k.id.into(), name: k.name.into() })
        .collect();
    out.dedup_by(|a, b| a.name == b.name);
    out.push(EditorInfo { id: TEXTEDIT.into(), name: "TextEdit".into() });
    out
}

/// The bundle id to use for a setting value ("auto" or a bundle id).
pub fn resolve(setting: &str) -> String {
    if setting != "auto" && crate::macos::app_path_for_bundle_id(setting).is_some() {
        return setting.to_string();
    }
    KNOWN
        .iter()
        .find(|k| crate::macos::app_path_for_bundle_id(k.id).is_some())
        .map(|k| k.id.to_string())
        .unwrap_or_else(|| TEXTEDIT.to_string())
}

pub fn line_url(bundle_id: &str, path: &Path, line: u32) -> Option<String> {
    let known = KNOWN.iter().find(|k| k.id == bundle_id)?;
    let template = known.line_url?;
    let encoded = utf8_percent_encode(&path.to_string_lossy(), PATH_ESCAPES).to_string();
    Some(template.replace("{path}", &encoded).replace("{line}", &line.to_string()))
}

pub fn open(setting: &str, path: &Path, line: Option<u32>) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let id = resolve(setting);
        let target = line
            .filter(|l| *l > 1)
            .and_then(|l| line_url(&id, path, l))
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let status = Command::new("/usr/bin/open")
            .args(["-b", &id, &target])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("The editor ({id}) couldn't open the file."))
        }
    } else {
        // Development fallback on Linux.
        let mut cmd = Command::new("code");
        cmd.arg("--goto").arg(format!(
            "{}:{}",
            path.to_string_lossy(),
            line.unwrap_or(1)
        ));
        match cmd.spawn() {
            Ok(_) => Ok(()),
            Err(_) => Command::new("xdg-open")
                .arg(path)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_urls_are_escaped() {
        let url = line_url("com.microsoft.VSCode", Path::new("/Users/a/My Notes/#1.md"), 12);
        assert_eq!(url.as_deref(), Some("vscode://file/Users/a/My%20Notes/%231.md:12"));
        assert!(line_url("com.barebones.bbedit", Path::new("/a.md"), 3).is_none());
    }
}
