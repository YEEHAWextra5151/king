//! `folio://open?path=…&view=…&line=…&window=new` — used by the `folio`
//! command for options that plain `open -b` can't carry.
//!
//! Deep links are untrusted input (any web page can link to them): paths are
//! canonicalized, only existing Markdown files or folders are opened, and
//! nothing else is ever done.

use std::path::{Path, PathBuf};
use url::Url;

use crate::paths;
use crate::settings::ViewMode;

#[derive(Debug, Default, PartialEq)]
pub struct DeepLinkOpen {
    pub paths: Vec<PathBuf>,
    pub view: Option<ViewMode>,
    pub line: Option<u32>,
    pub new_window: bool,
    pub stdin: bool,
}

const MAX_PATHS: usize = 256;

pub fn parse(url: &Url) -> Option<DeepLinkOpen> {
    if url.scheme() != "folio" {
        return None;
    }
    // `folio://open?…` puts "open" in the host; `folio:open?…` in the path.
    let action = url
        .host_str()
        .map(str::to_owned)
        .unwrap_or_else(|| url.path().trim_matches('/').to_owned());
    if !action.eq_ignore_ascii_case("open") {
        log::warn!("ignoring deep link with unknown action: {action}");
        return None;
    }
    let mut out = DeepLinkOpen::default();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "path" if out.paths.len() < MAX_PATHS => {
                if let Some(p) = validate_path(&value) {
                    out.paths.push(p);
                } else {
                    log::warn!("deep link: rejected path {value:?}");
                }
            }
            "view" => {
                out.view = match value.as_ref() {
                    "preview" => Some(ViewMode::Preview),
                    "code" => Some(ViewMode::Code),
                    "split" => Some(ViewMode::Split),
                    _ => None,
                }
            }
            "line" => out.line = value.parse::<u32>().ok().filter(|n| *n >= 1),
            "window" => out.new_window = value == "new",
            "stdin" => out.stdin = value == "1",
            _ => {}
        }
    }
    // A stdin request must point into the stdin temp directory.
    if out.stdin && !out.paths.iter().all(|p| paths::is_stdin_temp(p)) {
        out.stdin = false;
    }
    (!out.paths.is_empty()).then_some(out)
}

fn validate_path(raw: &str) -> Option<PathBuf> {
    let expanded = paths::expand_home(raw);
    if !expanded.is_absolute() {
        return None;
    }
    let canonical = paths::canonical(Path::new(&expanded))?;
    let meta = std::fs::metadata(&canonical).ok()?;
    if meta.is_dir() || (meta.is_file() && paths::is_markdown(&canonical)) {
        Some(canonical)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn parses_options_and_validates_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = paths::canonical(dir.path()).unwrap();
        let md = root.join("a b.md");
        std::fs::write(&md, "# x").unwrap();
        std::fs::write(root.join("script.sh"), "rm -rf /").unwrap();
        let enc = |p: &Path| {
            percent_encoding::utf8_percent_encode(
                &p.to_string_lossy(),
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string()
        };
        let link = format!(
            "folio://open?path={}&path={}&path={}&view=split&line=120&window=new&evil=1",
            enc(&md),
            enc(&root.join("script.sh")),
            enc(&root),
        );
        let parsed = parse(&url(&link)).unwrap();
        assert_eq!(parsed.paths, vec![md, root]);
        assert_eq!(parsed.view, Some(ViewMode::Split));
        assert_eq!(parsed.line, Some(120));
        assert!(parsed.new_window);
        assert!(!parsed.stdin);
    }

    #[test]
    fn rejects_everything_else() {
        assert!(parse(&url("folio://delete?path=/tmp")).is_none());
        assert!(parse(&url("https://open?path=/tmp")).is_none());
        assert!(parse(&url("folio://open?path=relative.md")).is_none());
        assert!(parse(&url("folio://open?path=/does/not/exist.md")).is_none());
        assert!(parse(&url("folio://open?path=/etc/passwd")).is_none());
        assert!(parse(&url("folio://open?line=3")).is_none());
    }

    /// The `folio` command builds links this parser must round-trip,
    /// including spaces, `&` and non-ASCII names.
    #[cfg(unix)]
    #[test]
    fn cli_links_round_trip() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = paths::canonical(dir.path()).unwrap();
        let docs = root.join("My Docs");
        std::fs::create_dir(&docs).unwrap();
        let md = docs.join("Ünïcode & more #1.md");
        std::fs::write(&md, "# x").unwrap();
        // A stand-in for macOS `open` that records its arguments.
        let bin = root.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let stub = bin.join("open");
        std::fs::write(&stub, "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"$OUT\"\n").unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let out = root.join("args.txt");
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/bin/folio");
        let status = std::process::Command::new("sh")
            .arg(&script)
            .args(["--split", "--line", "7", "My Docs/Ünïcode & more #1.md", "."])
            .current_dir(&root)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("OUT", &out)
            .status()
            .unwrap();
        assert!(status.success());
        let args = std::fs::read_to_string(&out).unwrap();
        let link = args.lines().last().unwrap();
        assert!(link.starts_with("folio://open?"), "{args}");
        let parsed = parse(&url(link)).unwrap();
        assert_eq!(parsed.paths, vec![md, root.clone()]);
        assert_eq!(parsed.view, Some(ViewMode::Split));
        assert_eq!(parsed.line, Some(7));
    }

    #[test]
    fn cli_version_matches_the_app() {
        let script = include_str!("../resources/bin/folio");
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let version = conf["version"].as_str().unwrap();
        assert!(script.contains(&format!("VERSION=\"{version}\"")), "update VERSION in resources/bin/folio");
        let id = conf["identifier"].as_str().unwrap();
        assert!(script.contains(&format!("BUNDLE_ID=\"{id}\"")));
    }

    #[test]
    fn stdin_flag_requires_temp_dir() {
        let dir = tempfile::tempdir().unwrap();
        let md = paths::canonical(dir.path()).unwrap().join("x.md");
        std::fs::write(&md, "x").unwrap();
        let link = format!("folio://open?path={}&stdin=1", md.display());
        let parsed = parse(&url(&link)).unwrap();
        assert!(!parsed.stdin);
    }
}
