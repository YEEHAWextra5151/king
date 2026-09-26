//! Folder listings for the sidebar and Open Quickly: Markdown files only,
//! walked with the `ignore` crate so .gitignore'd paths, `.git` and
//! `node_modules` are skipped.

use ignore::WalkBuilder;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::paths;

/// Keeps pathological folders (e.g. a whole home directory) responsive.
const MAX_FILES: usize = 20_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FolderNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub root: FolderNode,
    pub file_count: usize,
    pub truncated: bool,
}

/// Natural, case-insensitive ordering ("file2" < "file10"), folders first.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek(), bi.peek()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().filter(|c| c.is_ascii_digit()) {
                    na.push(*c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().filter(|c| c.is_ascii_digit()) {
                    nb.push(*c);
                    bi.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(ca), Some(cb)) => {
                let (la, lb) = (ca.to_lowercase().next(), cb.to_lowercase().next());
                if la != lb {
                    return la.cmp(&lb);
                }
                ai.next();
                bi.next();
            }
        }
    }
}

#[derive(Default)]
struct Dir {
    dirs: BTreeMap<String, Dir>,
    files: Vec<(String, PathBuf)>,
}

impl Dir {
    fn insert(&mut self, rel: &Path, full: PathBuf) {
        let mut comps: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let Some(file) = comps.pop() else { return };
        let mut node = self;
        for c in comps {
            node = node.dirs.entry(c).or_default();
        }
        node.files.push((file, full));
    }

    fn into_node(self, name: String, path: &Path) -> FolderNode {
        let mut dirs: Vec<FolderNode> = self
            .dirs
            .into_iter()
            .map(|(n, d)| {
                let p = path.join(&n);
                d.into_node(n, &p)
            })
            .collect();
        dirs.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        let mut files: Vec<FolderNode> = self
            .files
            .into_iter()
            .map(|(n, p)| FolderNode {
                name: n,
                path: paths::to_string(&p),
                is_dir: false,
                children: Vec::new(),
            })
            .collect();
        files.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        dirs.extend(files);
        FolderNode {
            name,
            path: paths::to_string(path),
            is_dir: true,
            children: dirs,
        }
    }
}

pub fn list(root: &Path) -> FolderListing {
    let mut tree = Dir::default();
    let mut count = 0;
    let mut truncated = false;
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_some_and(|t| t.is_dir())
                && matches!(name.as_ref(), "node_modules" | ".git"))
        })
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) || !paths::is_markdown(entry.path()) {
            continue;
        }
        if count >= MAX_FILES {
            truncated = true;
            break;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            tree.insert(rel, entry.path().to_path_buf());
            count += 1;
        }
    }
    FolderListing {
        root: tree.into_node(paths::display_name(root), root),
        file_count: count,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn natural_order() {
        let mut v = vec!["file10.md", "File2.md", "file1.md", "a.md"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["a.md", "file1.md", "File2.md", "file10.md"]);
    }

    #[test]
    fn lists_markdown_respecting_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("docs/deep")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::write(root.join("README.md"), "x").unwrap();
        fs::write(root.join("notes.txt"), "x").unwrap();
        fs::write(root.join("docs/guide.md"), "x").unwrap();
        fs::write(root.join("docs/deep/more.markdown"), "x").unwrap();
        fs::write(root.join("node_modules/pkg/README.md"), "x").unwrap();
        fs::write(root.join("build/out.md"), "x").unwrap();
        fs::write(root.join(".git/HEAD.md"), "x").unwrap();
        fs::write(root.join(".hidden.md"), "x").unwrap();

        let listing = list(root);
        assert_eq!(listing.file_count, 3);
        let names: Vec<&str> = listing.root.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["docs", "README.md"]);
        let docs = &listing.root.children[0];
        assert!(docs.is_dir);
        assert_eq!(docs.children[0].name, "deep");
        assert_eq!(docs.children[1].name, "guide.md");
    }
}
