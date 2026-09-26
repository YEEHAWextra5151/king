//! Access policy: the frontend may only read what the user opened.
//!
//! * Files the user opened (Finder, open panel, drop, CLI, deep link, recents,
//!   session restore).
//! * Files inside folders the user opened.
//! * Relative links followed from an allowed document.
//! * Bundled resources (help).
//!
//! Every read, listing, reveal and image grant goes through here.

use parking_lot::RwLock;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::documents;
use crate::paths;

#[derive(Default)]
struct Inner {
    files: HashSet<PathBuf>,
    dirs: HashSet<PathBuf>,
    /// Link targets that may be revealed in Finder but not read.
    revealable: HashSet<PathBuf>,
    /// Images granted to the asset protocol (Export ▸ HTML may inline them).
    images: HashSet<PathBuf>,
    /// Paths from native drag-and-drop events, with when they were dropped.
    dropped: Vec<(Instant, PathBuf)>,
    resource_dir: Option<PathBuf>,
}

#[derive(Default)]
pub struct Access {
    inner: RwLock<Inner>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    /// Open in the same tab (Preview).
    Markdown,
    /// Open in a Code-view tab.
    Text,
    /// A folder: open its README if it has one, otherwise reveal it.
    Directory,
    /// Any other local file: reveal in Finder, never launch.
    Other,
    Missing,
    /// Not a local reference (http, mailto, …); the caller handles it.
    External,
    /// Blocked scheme (javascript:, data:, custom schemes).
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    pub kind: LinkKind,
    pub path: Option<String>,
    /// For directories: the README/index that will be opened.
    pub readme: Option<String>,
    pub fragment: Option<String>,
    pub url: Option<String>,
}

impl LinkTarget {
    pub fn blocked() -> Self {
        LinkTarget {
            kind: LinkKind::Blocked,
            path: None,
            readme: None,
            fragment: None,
            url: None,
        }
    }
}

const DROP_TTL: Duration = Duration::from_secs(60);

impl Access {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        self.inner.write().resource_dir = paths::canonical(&dir).or(Some(dir));
    }

    pub fn grant_file(&self, path: &Path) {
        let p = paths::best_effort_canonical(path);
        self.inner.write().files.insert(p);
    }

    pub fn grant_dir(&self, path: &Path) {
        let p = paths::best_effort_canonical(path);
        self.inner.write().dirs.insert(p);
    }

    pub fn grant_reveal(&self, path: &Path) {
        let p = paths::best_effort_canonical(path);
        self.inner.write().revealable.insert(p);
    }

    /// Whether the frontend may read `path` (a file or, for listings, a dir).
    pub fn can_read(&self, path: &Path) -> bool {
        let p = paths::best_effort_canonical(path);
        let inner = self.inner.read();
        inner.files.contains(&p)
            || inner.dirs.iter().any(|d| p.starts_with(d))
            || inner.resource_dir.as_ref().is_some_and(|r| p.starts_with(r))
            // Also allow the lexical form, in case a granted file was since
            // deleted (so it can no longer be canonicalized).
            || inner.files.contains(&paths::normalize_lexically(path))
    }

    pub fn can_list(&self, dir: &Path) -> bool {
        let p = paths::best_effort_canonical(dir);
        self.inner.read().dirs.iter().any(|d| p.starts_with(d))
    }

    pub fn can_reveal(&self, path: &Path) -> bool {
        if self.can_read(path) {
            return true;
        }
        let p = paths::best_effort_canonical(path);
        let inner = self.inner.read();
        inner.revealable.contains(&p) || inner.dirs.contains(&p)
    }

    pub fn note_image(&self, path: &Path) {
        self.inner.write().images.insert(path.to_path_buf());
    }

    pub fn is_granted_image(&self, path: &Path) -> bool {
        self.inner.read().images.contains(&paths::best_effort_canonical(path))
    }

    pub fn record_drop(&self, dropped: &[PathBuf]) {
        let mut inner = self.inner.write();
        let now = Instant::now();
        inner.dropped.retain(|(t, _)| now.duration_since(*t) < DROP_TTL);
        for p in dropped {
            inner.dropped.push((now, paths::best_effort_canonical(p)));
        }
    }

    /// Keeps only the paths Rust itself saw in a native drop event.
    pub fn verify_dropped(&self, claimed: &[PathBuf]) -> Vec<PathBuf> {
        let inner = self.inner.read();
        let now = Instant::now();
        claimed
            .iter()
            .map(|p| paths::best_effort_canonical(p))
            .filter(|p| {
                inner
                    .dropped
                    .iter()
                    .any(|(t, d)| d == p && now.duration_since(*t) < DROP_TTL)
            })
            .collect()
    }

    /// Resolves an href found in `from` (an allowed document). Relative
    /// targets are granted so the frontend can open them.
    pub fn resolve_link(&self, from: &Path, href: &str, root: Option<&Path>) -> LinkTarget {
        let target = classify_href(from, href, root);
        if let Some(path) = target.path.as_deref().map(Path::new) {
            match target.kind {
                LinkKind::Markdown | LinkKind::Text => self.grant_file(path),
                LinkKind::Directory => {
                    self.grant_reveal(path);
                    if let Some(readme) = target.readme.as_deref() {
                        self.grant_file(Path::new(readme));
                    }
                }
                LinkKind::Other => self.grant_reveal(path),
                _ => {}
            }
        }
        target
    }

    /// Resolves an image `src` in `from` to a local image file, if it is one.
    pub fn resolve_image(&self, from: &Path, src: &str, root: Option<&Path>) -> Option<PathBuf> {
        let (path, _) = local_path_for_href(from, src, root)?;
        let canonical = paths::canonical(&path)?;
        (canonical.is_file() && paths::is_image(&canonical)).then_some(canonical)
    }
}

/// Splits `href` into a local filesystem path (relative hrefs resolved
/// against `from`'s folder) and an optional fragment. Returns `None` for
/// non-file URLs.
pub fn local_path_for_href(
    from: &Path,
    href: &str,
    root: Option<&Path>,
) -> Option<(PathBuf, Option<String>)> {
    let href = href.trim();
    if href.is_empty() || href.starts_with('#') {
        return None;
    }
    let lower = href.to_ascii_lowercase();
    let (raw_path, fragment) = if lower.starts_with("file:") {
        let url = url::Url::parse(href).ok()?;
        let fragment = url.fragment().map(str::to_owned);
        (url.to_file_path().ok()?, fragment)
    } else {
        if has_scheme(href) {
            return None;
        }
        let (without_fragment, fragment) = match href.split_once('#') {
            Some((p, f)) => (p, Some(f.to_string())),
            None => (href, None),
        };
        let without_query = without_fragment.split('?').next().unwrap_or("");
        let decoded = percent_decode_str(without_query).decode_utf8_lossy().into_owned();
        if decoded.is_empty() {
            return None;
        }
        let path = if let Some(stripped) = decoded.strip_prefix('/') {
            // GitHub treats `/docs/x.md` as relative to the repository root.
            // When the document lives in an opened folder, try that first.
            match root {
                Some(r) if r.join(stripped).exists() => r.join(stripped),
                _ => PathBuf::from(&decoded),
            }
        } else if let Some(rest) = decoded.strip_prefix("~/") {
            paths::expand_home(&format!("~/{rest}"))
        } else {
            from.parent().unwrap_or(Path::new("/")).join(&decoded)
        };
        (path, fragment)
    };
    Some((paths::normalize_lexically(&raw_path), fragment.filter(|f| !f.is_empty())))
}

fn has_scheme(href: &str) -> bool {
    // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
    let Some(colon) = href.find(':') else {
        return false;
    };
    let scheme = &href[..colon];
    !scheme.is_empty()
        && scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        // A Windows drive letter is not a scheme, but Folio is macOS-first.
        && scheme.len() > 1
}

pub fn classify_href(from: &Path, href: &str, root: Option<&Path>) -> LinkTarget {
    let blank = |kind| LinkTarget {
        kind,
        path: None,
        readme: None,
        fragment: None,
        url: None,
    };
    let trimmed = href.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
    {
        return LinkTarget {
            url: Some(trimmed.to_string()),
            ..blank(LinkKind::External)
        };
    }
    let Some((path, fragment)) = local_path_for_href(from, trimmed, root) else {
        return blank(LinkKind::Blocked);
    };
    let resolved = paths::canonical(&path);
    let Some(resolved) = resolved else {
        return LinkTarget {
            path: Some(paths::to_string(&path)),
            fragment,
            ..blank(LinkKind::Missing)
        };
    };
    let (kind, readme) = if resolved.is_dir() {
        (
            LinkKind::Directory,
            paths::find_readme(&resolved).map(|p| paths::to_string(&p)),
        )
    } else if paths::is_markdown(&resolved) {
        (LinkKind::Markdown, None)
    } else if !paths::is_image(&resolved)
        && (paths::is_known_text(&resolved) || documents::sniff_text(&resolved))
    {
        (LinkKind::Text, None)
    } else {
        (LinkKind::Other, None)
    };
    LinkTarget {
        kind,
        path: Some(paths::to_string(&resolved)),
        readme,
        fragment,
        url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = paths::canonical(dir.path()).unwrap();
        fs::create_dir_all(root.join("docs/img")).unwrap();
        fs::write(root.join("README.md"), "# r").unwrap();
        fs::write(root.join("docs/guide.md"), "# g").unwrap();
        fs::write(root.join("docs/notes.txt"), "plain").unwrap();
        fs::write(root.join("docs/img/pic.png"), [0x89, b'P', b'N', b'G', 0, 0]).unwrap();
        fs::write(root.join("docs/run.bin"), [0u8, 1, 2, 3]).unwrap();
        fs::write(root.join("logo.svg"), "<svg/>").unwrap();
        (dir, root)
    }

    #[test]
    fn classifies_relative_links() {
        let (_d, root) = setup();
        let from = root.join("docs/guide.md");
        let t = classify_href(&from, "../README.md#install", None);
        assert_eq!(t.kind, LinkKind::Markdown);
        assert_eq!(t.fragment.as_deref(), Some("install"));
        assert_eq!(t.path.unwrap(), paths::to_string(&root.join("README.md")));

        assert_eq!(classify_href(&from, "notes.txt", None).kind, LinkKind::Text);
        assert_eq!(classify_href(&from, "run.bin", None).kind, LinkKind::Other);
        assert_eq!(classify_href(&from, "img/pic.png", None).kind, LinkKind::Other);
        assert_eq!(classify_href(&from, "missing.md", None).kind, LinkKind::Missing);
        let dir = classify_href(&from, "..", None);
        assert_eq!(dir.kind, LinkKind::Directory);
        assert!(dir.readme.unwrap().ends_with("README.md"));
    }

    #[test]
    fn classifies_schemes() {
        let (_d, root) = setup();
        let from = root.join("README.md");
        assert_eq!(classify_href(&from, "https://x.io", None).kind, LinkKind::External);
        assert_eq!(classify_href(&from, "MAILTO:a@b.c", None).kind, LinkKind::External);
        assert_eq!(
            classify_href(&from, "javascript:alert(1)", None).kind,
            LinkKind::Blocked
        );
        assert_eq!(classify_href(&from, "vscode://x", None).kind, LinkKind::Blocked);
        assert_eq!(classify_href(&from, "data:text/html,x", None).kind, LinkKind::Blocked);
        let file_url = format!("file://{}", root.join("docs/guide.md").display());
        assert_eq!(classify_href(&from, &file_url, None).kind, LinkKind::Markdown);
    }

    #[test]
    fn percent_encoded_and_root_relative() {
        let (_d, root) = setup();
        fs::write(root.join("docs/with space.md"), "x").unwrap();
        let from = root.join("docs/guide.md");
        assert_eq!(
            classify_href(&from, "with%20space.md", None).kind,
            LinkKind::Markdown
        );
        let t = classify_href(&from, "/docs/guide.md", Some(&root));
        assert_eq!(t.kind, LinkKind::Markdown);
    }

    #[test]
    fn grants_follow_links_only() {
        let (_d, root) = setup();
        let access = Access::default();
        let readme = root.join("README.md");
        let guide = root.join("docs/guide.md");
        access.grant_file(&readme);
        assert!(access.can_read(&readme));
        assert!(!access.can_read(&guide));
        access.resolve_link(&readme, "docs/guide.md", None);
        assert!(access.can_read(&guide));
        // Other files become revealable, not readable.
        let bin = root.join("docs/run.bin");
        access.resolve_link(&guide, "run.bin", None);
        assert!(!access.can_read(&bin));
        assert!(access.can_reveal(&bin));
    }

    #[test]
    fn folder_grants_cover_descendants() {
        let (_d, root) = setup();
        let access = Access::default();
        access.grant_dir(&root.join("docs"));
        assert!(access.can_read(&root.join("docs/guide.md")));
        assert!(access.can_list(&root.join("docs/img")));
        assert!(!access.can_read(&root.join("README.md")));
    }

    #[test]
    fn images_resolve_including_parent_dirs() {
        let (_d, root) = setup();
        let access = Access::default();
        let from = root.join("docs/guide.md");
        assert!(access.resolve_image(&from, "img/pic.png", None).is_some());
        assert!(access.resolve_image(&from, "../logo.svg", None).is_some());
        assert!(access.resolve_image(&from, "run.bin", None).is_none());
        assert!(access.resolve_image(&from, "https://x.io/a.png", None).is_none());
        assert!(access.resolve_image(&from, "nope.png", None).is_none());
    }

    #[test]
    fn drops_must_be_seen_by_rust() {
        let (_d, root) = setup();
        let access = Access::default();
        let a = root.join("README.md");
        let b = root.join("docs/guide.md");
        access.record_drop(std::slice::from_ref(&a));
        assert_eq!(access.verify_dropped(&[a.clone(), b]), vec![a]);
    }
}
