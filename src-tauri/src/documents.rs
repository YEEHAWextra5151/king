//! Reading documents from disk: stat, iCloud placeholders, size limits, and
//! text decoding (UTF-8, UTF-8/UTF-16 BOMs, Windows-1252 fallback) with line
//! endings normalized to `\n`.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::paths;

/// Above this, a Markdown file opens in Code view with an offer to render.
pub const LARGE_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// Above this, Folio refuses to load the file at all.
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DocKind {
    Markdown,
    Text,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    pub path: String,
    pub name: String,
    pub text: String,
    pub kind: DocKind,
    /// "utf-8", "utf-16le", "utf-16be" or "windows-1252".
    pub encoding: &'static str,
    pub had_bom: bool,
    /// True when the bytes weren't valid in any detected encoding and
    /// Windows-1252 was used as a fallback (the UI shows a notice).
    pub fallback_encoding: bool,
    /// "lf", "crlf", "cr", "mixed" or "none".
    pub line_ending: &'static str,
    pub size: u64,
    pub modified_ms: f64,
    pub large: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    NotFound,
    PermissionDenied,
    IsDirectory,
    TooLarge,
    Binary,
    NotAllowed,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ReadResult {
    Ready(DocumentPayload),
    /// iCloud placeholder that is being downloaded; a `document-changed`
    /// event follows once the file is local.
    Downloading { path: String, name: String },
    Error {
        path: String,
        name: String,
        code: ErrorCode,
        message: String,
    },
}

impl ReadResult {
    pub fn error(path: &Path, code: ErrorCode, message: impl Into<String>) -> Self {
        ReadResult::Error {
            path: paths::to_string(path),
            name: paths::display_name(path),
            code,
            message: message.into(),
        }
    }
}

pub fn modified_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Whether the file is an APFS "dataless" iCloud placeholder (SF_DATALESS).
/// Reading such a file blocks until it has been downloaded.
#[cfg(target_os = "macos")]
pub fn is_dataless(meta: &fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    const SF_DATALESS: u32 = 0x4000_0000;
    meta.st_flags() & SF_DATALESS != 0
}

#[cfg(not(target_os = "macos"))]
pub fn is_dataless(_meta: &fs::Metadata) -> bool {
    false
}

/// Old-style iCloud stub: `dir/.Name.md.icloud` exists instead of `dir/Name.md`.
pub fn icloud_stub_for(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let stub = path.with_file_name(format!(".{name}.icloud"));
    stub.exists().then_some(stub)
}

pub enum Probe {
    Ready(fs::Metadata),
    Downloading,
    Failed(ReadResult),
}

/// Stats `path` and classifies it without reading the contents.
pub fn probe(path: &Path) -> Probe {
    match fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Probe::Failed(ReadResult::error(
            path,
            ErrorCode::IsDirectory,
            "This is a folder.",
        )),
        Ok(meta) if meta.len() > MAX_FILE_BYTES => Probe::Failed(ReadResult::error(
            path,
            ErrorCode::TooLarge,
            format!(
                "This file is {}. Folio opens files up to {}.",
                human_size(meta.len()),
                human_size(MAX_FILE_BYTES)
            ),
        )),
        Ok(meta) if is_dataless(&meta) => Probe::Downloading,
        Ok(meta) => Probe::Ready(meta),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if icloud_stub_for(path).is_some() {
                Probe::Downloading
            } else {
                Probe::Failed(ReadResult::error(
                    path,
                    ErrorCode::NotFound,
                    "The file can't be found. It may have been moved, renamed, or deleted.",
                ))
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => Probe::Failed(
            ReadResult::error(path, ErrorCode::PermissionDenied, permission_message()),
        ),
        Err(err) => Probe::Failed(ReadResult::error(path, ErrorCode::Other, err.to_string())),
    }
}

fn permission_message() -> &'static str {
    "Folio doesn't have permission to read this file. Check its permissions in Finder, or allow access in System Settings ▸ Privacy & Security ▸ Files and Folders."
}

/// Reads and decodes a document. `kind` decides how the UI shows it.
pub fn read(path: &Path, kind: DocKind) -> ReadResult {
    let meta = match probe(path) {
        Probe::Ready(meta) => meta,
        Probe::Downloading => {
            return ReadResult::Downloading {
                path: paths::to_string(path),
                name: paths::display_name(path),
            }
        }
        Probe::Failed(result) => return result,
    };
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            return ReadResult::error(path, ErrorCode::PermissionDenied, permission_message())
        }
        Err(err) => return ReadResult::error(path, ErrorCode::Other, err.to_string()),
    };
    if looks_binary(&bytes) {
        return ReadResult::error(
            path,
            ErrorCode::Binary,
            "This file doesn't look like text, so Folio can't show it.",
        );
    }
    let decoded = decode(&bytes);
    let (text, line_ending) = normalize_line_endings(decoded.text);
    ReadResult::Ready(DocumentPayload {
        path: paths::to_string(path),
        name: paths::display_name(path),
        text,
        kind,
        encoding: decoded.encoding,
        had_bom: decoded.had_bom,
        fallback_encoding: decoded.fallback,
        line_ending,
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        large: meta.len() > LARGE_FILE_BYTES,
    })
}

pub struct Decoded {
    pub text: String,
    pub encoding: &'static str,
    pub had_bom: bool,
    pub fallback: bool,
}

/// Decodes bytes: BOMs first (UTF-8, UTF-16LE, UTF-16BE), then strict UTF-8,
/// then Windows-1252 (which maps every byte, so decoding never fails).
pub fn decode(bytes: &[u8]) -> Decoded {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        let (text, _) = encoding_rs::UTF_8.decode_without_bom_handling(rest);
        return Decoded {
            text: text.into_owned(),
            encoding: "utf-8",
            had_bom: true,
            fallback: false,
        };
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(&bytes[2..]);
        return Decoded {
            text: text.into_owned(),
            encoding: "utf-16le",
            had_bom: true,
            fallback: false,
        };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _) = encoding_rs::UTF_16BE.decode_without_bom_handling(&bytes[2..]);
        return Decoded {
            text: text.into_owned(),
            encoding: "utf-16be",
            had_bom: true,
            fallback: false,
        };
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Decoded {
            text: text.to_owned(),
            encoding: "utf-8",
            had_bom: false,
            fallback: false,
        },
        Err(_) => {
            let (text, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            Decoded {
                text: text.into_owned(),
                encoding: "windows-1252",
                had_bom: false,
                fallback: true,
            }
        }
    }
}

/// Converts CRLF and lone CR to LF and reports what the file used.
pub fn normalize_line_endings(text: String) -> (String, &'static str) {
    let crlf = text.matches("\r\n").count();
    let cr_total = text.matches('\r').count();
    let lone_cr = cr_total - crlf;
    let lf_total = text.matches('\n').count();
    let lone_lf = lf_total - crlf;
    let kinds = [crlf > 0, lone_cr > 0, lone_lf > 0]
        .iter()
        .filter(|b| **b)
        .count();
    let ending = match (kinds, crlf > 0, lone_cr > 0) {
        (0, _, _) => "none",
        (1, true, _) => "crlf",
        (1, _, true) => "cr",
        (1, _, _) => "lf",
        _ => "mixed",
    };
    if cr_total == 0 {
        return (text, ending);
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    (normalized, ending)
}

/// NUL bytes in the first 8 KB (without a UTF-16 BOM) mean binary.
pub fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// Content check for link targets with unknown extensions: small prefix,
/// no NULs, and mostly valid UTF-8.
pub fn sniff_text(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 8192];
    let Ok(n) = file.read(&mut buf) else {
        return false;
    };
    let head = &buf[..n];
    if looks_binary(head) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        // A multi-byte sequence may be cut at the buffer boundary.
        Err(e) => e.error_len().is_none() && e.valid_up_to() + 4 >= n,
    }
}

pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["bytes", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} bytes")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_plain_utf8() {
        let d = decode("héllo".as_bytes());
        assert_eq!(d.text, "héllo");
        assert_eq!(d.encoding, "utf-8");
        assert!(!d.had_bom && !d.fallback);
    }

    #[test]
    fn strips_utf8_bom() {
        let d = decode(b"\xEF\xBB\xBF# Title");
        assert_eq!(d.text, "# Title");
        assert!(d.had_bom);
    }

    #[test]
    fn decodes_utf16_boms() {
        let le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("# Hé".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        let d = decode(&le);
        assert_eq!(d.text, "# Hé");
        assert_eq!(d.encoding, "utf-16le");

        let be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain("# Hé".encode_utf16().flat_map(|u| u.to_be_bytes()))
            .collect();
        let d = decode(&be);
        assert_eq!(d.text, "# Hé");
        assert_eq!(d.encoding, "utf-16be");
        assert!(!looks_binary(&be));
    }

    #[test]
    fn falls_back_to_windows_1252() {
        // "café" in Windows-1252, plus smart quotes 0x93/0x94.
        let d = decode(b"caf\xE9 \x93hi\x94");
        assert_eq!(d.text, "café \u{201C}hi\u{201D}");
        assert_eq!(d.encoding, "windows-1252");
        assert!(d.fallback);
    }

    #[test]
    fn normalizes_line_endings() {
        assert_eq!(
            normalize_line_endings("a\r\nb\r\n".into()),
            ("a\nb\n".to_string(), "crlf")
        );
        assert_eq!(normalize_line_endings("a\rb".into()), ("a\nb".to_string(), "cr"));
        assert_eq!(normalize_line_endings("a\nb".into()), ("a\nb".to_string(), "lf"));
        assert_eq!(
            normalize_line_endings("a\r\nb\nc".into()),
            ("a\nb\nc".to_string(), "mixed")
        );
        assert_eq!(normalize_line_endings("abc".into()).1, "none");
    }

    #[test]
    fn reads_missing_file_as_calm_error() {
        let dir = tempfile::tempdir().unwrap();
        match read(&dir.path().join("nope.md"), DocKind::Markdown) {
            ReadResult::Error { code, .. } => assert_eq!(code, ErrorCode::NotFound),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn reads_directory_as_error() {
        let dir = tempfile::tempdir().unwrap();
        match read(dir.path(), DocKind::Markdown) {
            ReadResult::Error { code, .. } => assert_eq!(code, ErrorCode::IsDirectory),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn detects_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bin.md");
        std::fs::write(&p, b"PK\x03\x04\x00\x00junk").unwrap();
        match read(&p, DocKind::Markdown) {
            ReadResult::Error { code, .. } => assert_eq!(code, ErrorCode::Binary),
            other => panic!("unexpected {other:?}"),
        }
        assert!(!sniff_text(&p));
    }

    #[test]
    fn reads_crlf_document() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("win.md");
        std::fs::write(&p, b"# T\r\n\r\nbody\r\n").unwrap();
        match read(&p, DocKind::Markdown) {
            ReadResult::Ready(doc) => {
                assert_eq!(doc.text, "# T\n\nbody\n");
                assert_eq!(doc.line_ending, "crlf");
                assert!(!doc.large);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn icloud_stub_detection() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("Notes.md");
        assert!(icloud_stub_for(&real).is_none());
        std::fs::write(dir.path().join(".Notes.md.icloud"), b"stub").unwrap();
        assert!(icloud_stub_for(&real).is_some());
        assert!(matches!(probe(&real), Probe::Downloading));
    }

    #[test]
    fn human_sizes() {
        assert_eq!(human_size(512), "512 bytes");
        assert_eq!(human_size(12_400_000), "12.4 MB");
    }
}
