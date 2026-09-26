//! Path helpers shared by the router, access policy and commands.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

/// Extensions Folio renders as Markdown (matches the bundle's file associations).
pub const MARKDOWN_EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt", "mdtext",
];

/// Image extensions a document may reference through the asset protocol.
pub const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "apng", "bmp", "ico", "tif", "tiff",
    "heic", "heif",
];

/// Extensions that are always treated as text/code (opened in a Code-view tab).
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "text", "log", "csv", "tsv", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini",
    "cfg", "conf", "xml", "html", "htm", "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx",
    "ts", "mts", "cts", "tsx", "vue", "svelte", "py", "pyi", "rb", "rs", "go", "java", "kt", "kts",
    "swift", "m", "mm", "h", "hpp", "hh", "c", "cc", "cpp", "cxx", "cs", "fs", "php", "pl", "pm",
    "lua", "r", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "dockerfile", "make",
    "mk", "cmake", "gradle", "properties", "env", "gitignore", "gitattributes", "editorconfig",
    "tex", "bib", "rst", "adoc", "asciidoc", "org", "diff", "patch", "graphql", "gql", "proto",
    "zig", "nim", "ex", "exs", "erl", "hrl", "clj", "cljs", "edn", "scala", "sc", "dart", "elm",
    "hs", "ml", "mli", "jl", "vim", "el", "lisp", "scm", "rkt", "sol", "tf", "hcl", "nix",
    "lock", "svg",
];

/// Well-known extension-less text files.
const TEXT_FILE_NAMES: &[&str] = &[
    "readme", "license", "licence", "copying", "authors", "contributors", "changelog",
    "makefile", "dockerfile", "gemfile", "rakefile", "procfile", "brewfile", "justfile",
    "vagrantfile", "codeowners", "notice", "todo",
];

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|e| e.to_ascii_lowercase())
}

pub fn is_markdown(path: &Path) -> bool {
    ext_lower(path).is_some_and(|e| MARKDOWN_EXTENSIONS.contains(&e.as_str()))
}

pub fn is_image(path: &Path) -> bool {
    ext_lower(path).is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.as_str()))
}

/// Cheap name-based guess; `documents::sniff_text` confirms by content.
pub fn is_known_text(path: &Path) -> bool {
    if let Some(ext) = ext_lower(path) {
        return TEXT_EXTENSIONS.contains(&ext.as_str());
    }
    path.file_name()
        .and_then(OsStr::to_str)
        .map(|n| TEXT_FILE_NAMES.contains(&n.to_ascii_lowercase().as_str()) || n.starts_with('.'))
        .unwrap_or(false)
}

/// Canonical absolute path (symlinks resolved), or `None` if it doesn't exist.
pub fn canonical(path: &Path) -> Option<PathBuf> {
    dunce::canonicalize(path).ok()
}

/// Lexically normalizes `.` and `..` without touching the filesystem.
/// Used for paths that may not exist (so they can't be canonicalized).
pub fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                // `/..` is `/`.
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => out.push(component),
            },
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Canonicalizes when possible, otherwise normalizes lexically. Always absolute
/// when the input is absolute.
pub fn best_effort_canonical(path: &Path) -> PathBuf {
    canonical(path).unwrap_or_else(|| normalize_lexically(path))
}

pub fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

pub fn to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Finds a README or index file inside `dir`, preferring README.
pub fn find_readme(dir: &Path) -> Option<PathBuf> {
    let entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_markdown(p))
        .collect();
    let stem_is = |p: &PathBuf, name: &str| {
        p.file_stem()
            .and_then(OsStr::to_str)
            .is_some_and(|s| s.eq_ignore_ascii_case(name))
    };
    let mut readmes: Vec<&PathBuf> = entries.iter().filter(|p| stem_is(p, "readme")).collect();
    readmes.sort_by_key(|p| {
        // Prefer .md over the rarer extensions, and exact "README" casing.
        let ext_rank = if ext_lower(p).as_deref() == Some("md") { 0 } else { 1 };
        let case_rank = if p.file_stem() == Some(OsStr::new("README")) { 0 } else { 1 };
        (ext_rank, case_rank)
    });
    if let Some(p) = readmes.first() {
        return Some((*p).clone());
    }
    entries.iter().find(|p| stem_is(p, "index")).cloned()
}

/// Expands a leading `~` (used by deep links and the CLI's stdin directory).
pub fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// Directory where the `folio -` command stores Standard Input.
/// Must match `identifier` in tauri.conf.json (a test checks).
pub const BUNDLE_ID: &str = "dev.yourname.folio";

pub fn stdin_dir() -> PathBuf {
    std::env::temp_dir().join(BUNDLE_ID).join("stdin")
}

pub fn is_stdin_temp(path: &Path) -> bool {
    let dir = best_effort_canonical(&stdin_dir());
    path.starts_with(&dir) || path.starts_with(stdin_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_id_matches_the_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"].as_str(), Some(BUNDLE_ID));
    }

    #[test]
    fn markdown_extensions_are_case_insensitive() {
        assert!(is_markdown(Path::new("/a/README.MD")));
        assert!(is_markdown(Path::new("notes.mdown")));
        assert!(is_markdown(Path::new("x.mdtext")));
        assert!(!is_markdown(Path::new("x.txt")));
        assert!(!is_markdown(Path::new("md")));
    }

    #[test]
    fn lexical_normalization() {
        assert_eq!(
            normalize_lexically(Path::new("/a/b/../c/./d.md")),
            PathBuf::from("/a/c/d.md")
        );
        assert_eq!(normalize_lexically(Path::new("/a/../../b")), PathBuf::from("/b"));
        assert_eq!(normalize_lexically(Path::new("../x")), PathBuf::from("../x"));
        assert_eq!(normalize_lexically(Path::new("a/../../x")), PathBuf::from("../x"));
    }

    #[test]
    fn known_text_files() {
        assert!(is_known_text(Path::new("main.rs")));
        assert!(is_known_text(Path::new("Makefile")));
        assert!(is_known_text(Path::new(".env")));
        assert!(!is_known_text(Path::new("photo.png")));
    }

    #[test]
    fn readme_preference() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.md"), "i").unwrap();
        assert_eq!(
            find_readme(dir.path()).unwrap().file_name().unwrap(),
            "index.md"
        );
        std::fs::write(dir.path().join("readme.markdown"), "r").unwrap();
        std::fs::write(dir.path().join("README.md"), "R").unwrap();
        assert_eq!(
            find_readme(dir.path()).unwrap().file_name().unwrap(),
            "README.md"
        );
    }
}
