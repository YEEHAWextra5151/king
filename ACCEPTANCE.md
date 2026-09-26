# Acceptance report

What was verified, how, and what still needs a Mac. Folio was built in a
Linux container: the macOS-only code (objc2/AppKit glue, LaunchServices,
NSOpenPanel, native menus' AppKit roles, Finder integration) compiles and
type-checks for both Apple targets (`scripts/check-macos.sh`), but it hasn't
run. Everything else was exercised in three ways:

- **Unit tests** — `pnpm test` (39 Vitest tests: rendering, heading ids,
  sanitizer, regex cache, paths, fuzzy matching) and `cargo test` (56 Rust
  tests: decoding, access policy, link resolution, deep links, the `folio`
  script, sessions, registry, watcher classification, menus).
- **e2e** — `node e2e/run.mjs`: the production bundle in Chromium with the
  production CSP and a mocked Tauri runtime. 180 checks across 20 scenarios,
  plus screenshots for visual review. All pass.
- **The real app** — the Tauri build for Linux (same Rust and frontend; the
  macOS glue swapped for no-op fallbacks) running in WebKitGTK under Xvfb,
  driven with xdotool: files, folders, deep links, menus and shortcuts, live
  reload, session restore, and timing from the app's own `perf:` log.

Legend: ✅ verified · 🍎 implemented, needs a Mac to verify · ⚠️ partial ·
⏭ follow-up.

## 0 · Principles

| Requirement | Status | Evidence |
|---|---|---|
| The document is the interface | ✅ | Screenshots in `test-results/e2e/` (tabs in the title-bar row, no other chrome). |
| No spinners | ✅ | None exist; slow work (highlighting, diagrams) is progressive. |
| No white flash | ✅ 🍎 | Windows are created hidden with the surface as native background, critical CSS inline, theme applied by an init script before any page script; shown only after the first document is laid out (real app: `window-ready` follows `render-committed`). `drawsBackground = NO` needs a Mac to see. |
| No layout shift | ✅ | e2e measures CLS < 0.01 on the README fixture; image sizes are reserved; highlighting and diagrams replace same-size boxes. |
| Never modifies files | ✅ | No write path to documents exists; only settings/session/recents in the app's data folder and Export ▸ HTML to a new file chosen in a save panel. |
| No telemetry, all assets bundled | ✅ | CSP `default-src 'self'`, `connect-src` only IPC; no analytics or update code. |
| Network only for images/links the document references | ✅ | e2e: remote badges requested only while "Load images from the internet" is on; blocked with it off. External links go to the browser via Rust. |

## 1 · Stack

| Requirement | Status | Evidence |
|---|---|---|
| Tauri 2 (latest), Rust stable, pnpm | ✅ | Tauri 2.11.6; see DECISIONS.md ▸ Versions. |
| TS strict, Vite, React 19, Zustand, hand-written CSS | ✅ | `tsconfig.json` strict; no UI kit. |
| markdown-it + footnotes, task lists, front matter, emoji, alerts, KaTeX, GitHub anchors | ✅ | Vitest + e2e `readme`, `help`. |
| Parse + highlight in a Web Worker; DOMPurify on the main thread | ✅ | `render/worker.ts`; `render/sanitize.ts`. |
| Shiki, dual light/dark via CSS variables, lazy grammars | ✅ | e2e checks `--shiki-token` spans; grammars load per fence language. |
| Mermaid via dynamic import | ✅ | e2e `readme` (SVG rendered). |
| CodeMirror 6 | ✅ | e2e `views`. |
| Plugins dialog/opener/deep-link/store/log; notify + debouncer; ignore; objc2 | ✅ | `Cargo.toml`. |
| macOS 13+, universal, not sandboxed, ad-hoc signing; Developer ID documented | ✅ 🍎 | `minimumSystemVersion: "13.0"`, `signingIdentity: "-"`, hardened runtime; README ▸ Signing. The universal `.app`/`.dmg` must be built on a Mac. |

## 2 · Default app, opening files

| Requirement | Status | Evidence |
|---|---|---|
| Viewer associations for md, markdown, mdown, mkd, mkdn, mdwn, mdtxt, mdtext; `net.daringfireball.markdown` imported, conforming to `public.plain-text` | ✅ 🍎 | `bundle.fileAssociations` + `src-tauri/Info.plist`; bundle output needs a Mac. |
| `public.folder` with LSHandlerRank None | ✅ 🍎 | Same. |
| `RunEvent::Opened` with a cold-launch queue, no Welcome flash | ✅ 🍎 | Queue is pre-registered state; windows are created only in `setup` after draining it (80 ms grace before Welcome). Linux run: files on the command line open without a Welcome window. |
| 10 files → 10 tabs in one window; dedupe by canonical path | ✅ | e2e `manytabs` (10 tabs), `tabs` (dedupe); real app: 3 files → 3 tabs. |
| ⌘O: native panel, files and folders, multiple selection | 🍎 | NSOpenPanel via objc2 (`macos.rs`). |
| Drops anywhere; on the tab bar, insert at position | ✅ 🍎 | e2e `tabs` (drop between tabs → `insertAt: 1`, tabs appear there). Rust only opens paths it saw in the native drop event. |
| Settings ▸ General default status + Make Default (`setDefaultApplicationAtURL:toOpenContentType:`) | ✅ 🍎 | UI and banner in e2e `settings`, `extras`; the LaunchServices call needs a Mac. |
| First-launch banner, once | ✅ | e2e `extras`; `defaultAppBannerShown` persisted. |
| Open Recent (persisted, Clear Menu) + `noteNewRecentDocumentURL:` | ✅ 🍎 | `recents.json` written in the real app; NSDocumentController call needs a Mac. |
| Restore reading position | ✅ | e2e `restore`; real app (reopened at the saved scroll position). |
| Keep running with no windows; Reopen → Welcome; menus with zero windows | 🍎 | `ExitRequested` handling and `RunEvent::Reopen` in `lib.rs`. |
| Calm errors | ✅ | e2e `errors` (missing file, missing link target). |
| UTF-8/BOM, UTF-16 BOM, Windows-1252 fallback with notice, CRLF | ✅ | Rust `documents` tests; the notice is a banner (e2e covers banners). |
| > 10 MB opens in Code view with an offer to render | ✅ | e2e `large`. |
| iCloud placeholders show "Downloading…" | 🍎 | `SF_DATALESS` detection, macOS only. |

## 3 · The `folio` command

| Requirement | Status | Evidence |
|---|---|---|
| Install Command Line Tool (symlink with admin prompt, `~/.local/bin` fallback) | 🍎 | `cli_install.rs` (osascript prompt is macOS-only). |
| `folio README.md docs/*.md`, `folio .`, `cat … \| folio -` | ✅ | Script run under `dash` and `bash --posix` with a stub `open`; Rust test `cli_links_round_trip`. |
| `--code`, `--split`, `--line`, `--new-window`, `--help`, `--version` | ✅ | Same; `cli_version_matches_the_app`. |
| Plain paths via `open -b`; options via `folio://open?…` | ✅ | Same. |
| Deep links are untrusted: canonicalize, only existing Markdown files or folders | ✅ | Rust `deeplink` tests (rejects other actions, relative paths, missing files, `/etc/passwd`, `stdin=1` outside the temp dir). Real app: `folio://open?…&view=split&line=300` lands both panes on line 300. |
| Standard Input: temp file titled "Standard Input", not in Recents, cleaned next launch | ✅ | Script writes to `$TMPDIR/dev.yourname.folio/stdin/`; router and session skip it; `clean_stdin_dir` on launch. |
| Identical whether Folio is running or not | ✅ 🍎 | Both go through `open -b` → `RunEvent::Opened`. |

## 4 · Tabs and windows

| Requirement | Status | Evidence |
|---|---|---|
| One webview per window, tabs are app state, no native tabbing | ✅ 🍎 | Architecture; `NSWindow.allowsAutomaticWindowTabbing = NO` at launch (macOS). |
| ⌘N cascaded windows ~920×820, min 520×400, frames remembered | ✅ 🍎 | Config + `cascade_frame`; frames saved in the session (real app). |
| Tab bar in the unified title-bar row; active tab's surface flows into the document | ✅ | Screenshots. Traffic-light inset is computed from AppKit metrics 🍎. |
| Close button on hover; middle-click closes; drag to reorder; overflow scroll + chevron menu | ✅ | e2e `tabs`, `manytabs`. |
| Disambiguation "README.md — api" | ✅ | e2e `tabs`; real app. |
| Empty toolbar drags the window; double-click follows `AppleActionOnDoubleClick` | 🍎 | `start_window_drag`, `toolbar_double_click`. |
| Native tab context menu (Close, Close Others, Close Tabs to the Right, Copy Path, Reveal in Finder, Open in Editor, Move to New Window) | ✅ 🍎 | e2e checks the items and runs Copy Path; the NSMenu itself needs a Mac. |
| ⌘-click tab → path menu | 🍎 | `popup_path_menu`. |
| Window ▸ Merge All Windows; Move Tab to New Window | 🍎 | Rust registry + window creation. |
| Rust-authoritative registry; window title = active document | ✅ | Registry sync in e2e; real app window titles follow the active tab. |
| Per-tab view mode, scroll, split ratio, history | ✅ | e2e `tabs` (scroll kept), `views` (ratio), `readme` (history). |
| ~5 MRU tabs mounted; older rebuilt from cached HTML | ✅ | e2e `manytabs` (≤ 6 mounted, rebuild timed). |
| Session restore System/Always/Never, missing files skipped with a notice | ✅ | Real app (Always); e2e `restore` (notice); Rust session tests. "System" reads `NSQuitAlwaysKeepsWindows` 🍎. |
| Welcome view (icon, Open File…, Open Folder…, recents, drop hint) | ✅ | e2e `welcome` (light/dark). |

## 5 · Preview, Code, Split

| Requirement | Status | Evidence |
|---|---|---|
| Segmented control; ⌘/ and ⌘\\; default mode setting; remember per file | ✅ | e2e `views`; settings. |
| Code view: read-only, navigable, line numbers, soft wrap ⌥Z, fold by heading, fenced highlighting, same palette | ✅ | e2e `views` (typing doesn't edit, `aria-readonly`); screenshots. |
| Split: draggable divider (ratio kept), bidirectional scroll sync via source lines | ✅ | e2e `views`; real app deep link. |
| Double-click a rendered block → its line in Code view | ✅ | e2e `views`. |
| ⇧⌘E Open in Editor (VS Code, Cursor, Zed, Sublime, BBEdit; TextEdit fallback; never the default handler) | ✅ 🍎 | `editor.rs` tests (line URLs escaped); launching editors needs a Mac. |

## 6 · Theme

| Requirement | Status | Evidence |
|---|---|---|
| Claude tokens (light/dark), semantic colors, alert mapping | ✅ | `src/styles/tokens.css`; screenshots. |
| One syntax palette for Shiki and CodeMirror, 4.5:1 on recessed | ✅ | Two colors nudged to reach 4.5:1 (DECISIONS.md). |
| Selection tint, focus ring (focus-visible) | ✅ | CSS. |
| Fonts, sizes, reading widths (60/72/90/Full) | ✅ | e2e `themes` (wide width), `zoom`. |
| Code blocks: label + copy on hover | ✅ | e2e `readme` (copy). |
| Tables, image zoom, custom checkboxes | ✅ | Screenshots; image zoom overlay. |
| GitHub and Paper themes | ✅ | e2e `themes` (light and dark each, live switch). |
| Custom CSS themes from `~/Library/Application Support/Folio/themes`, hot-reloaded | ✅ 🍎 | `themes.rs` watcher; the folder path is macOS's. |
| Increase Contrast, Reduce Motion | ✅ | `prefers-contrast: more` tokens; e2e `reload` (no tint animation under Reduce Motion). |

## 7 · Rendering

| Requirement | Status | Evidence |
|---|---|---|
| CommonMark + GFM, alerts, front matter (hidden or card), emoji, KaTeX, Mermaid (base theme, strict, near viewport) | ✅ | Vitest; e2e `readme`, `help`. |
| GitHub-exact heading ids | ✅ | Vitest (github-slugger, duplicates, `user-content-` prefix). |
| Safe HTML subset only; no scripts, iframes, forms, handlers, `javascript:` | ✅ | Vitest sanitizer tests; e2e `security` (hostile fixture: nothing runs, no forbidden elements, no handlers, no style attributes, no clobbering). |
| Relative images via the asset protocol, granted narrowly | ✅ | e2e loads images through `http://asset.localhost/…`; grants are per file (DECISIONS.md). |
| Remote images on by default, setting to block | ✅ | e2e `extras`. |
| Link routing (anchors, relative .md with history/⌘-click, text → Code tab, other local files revealed, http/https/mailto → browser, rest blocked) | ✅ | e2e `readme`, `security`, `errors`; Rust `access` tests. |
| The webview never navigates away (intercepted in Rust) | ✅ 🍎 | `on_navigation`/`on_new_window` guards; e2e fails on any top-level navigation. |
| Graceful inline errors (math, diagrams) | ✅ | Vitest (math errors); Mermaid error box. |
| Per-block caching by content hash | ✅ | Vitest block-diff tests; e2e `reload` (unchanged blocks keep their DOM). |

## 8 · Sidebar, find, navigation

| Requirement | Status | Evidence |
|---|---|---|
| Sidebar (⌃⌘S): Outline + Files (ignore rules) | ✅ | e2e `sidebar`; real app folder open. |
| Open Folder ⌥⌘O; Open Quickly ⇧⌘O (fuzzy) | ✅ | e2e `quickopen`; real app. |
| Find ⌘F/⌘G/⇧⌘G/⌘E/Esc with count; Highlight API with fallback; CodeMirror search | ✅ | e2e `find` (preview and code); real app. |
| Back ⌘[ / Forward ⌘]; next/previous heading ⌥⌘↓/↑ | ✅ | e2e `readme` (history). |
| Document focused on open; text zoom reflows; ⌘A document-only | ✅ | e2e `readme`, `zoom`, `extras`. |
| Copy rich + plain; Copy as Markdown / HTML | ✅ 🍎 | e2e `extras`; the rich pasteboard write needs a Mac. |
| Optional status bar | ✅ | e2e `extras`. |

## 9 · Live reload

| Requirement | Status | Evidence |
|---|---|---|
| Parent-directory watching, ~100 ms debounce, shared watchers, polling on network volumes | ✅ | Real app (appending to a watched file re-rendered it); Rust watcher tests. Network-volume polling 🍎. |
| mtime re-check on activation | 🍎 | `recheck_all` on app activation. |
| Incremental re-render anchored to the reading position | ✅ | e2e `reload` (top block keeps its offset to the pixel; DOM reused). |
| Changed-block tint (setting; skipped under Reduce Motion) | ✅ | e2e `reload`. |
| Moved/deleted banner with Close and Locate… | ✅ 🍎 | e2e `reload` (banner, last content kept); Locate uses a native panel. |
| ⌘R | ✅ | Menu → `reload` action. |

## 10 · Native details

| Requirement | Status | Evidence |
|---|---|---|
| Overlay title bar, hidden title, traffic lights centered in the 44 px toolbar, inset reclaimed in full screen | 🍎 | `windows.rs`, `macos.rs`; `window-state` event. |
| Complete menu bar with shortcuts, enabled state and checkmarks; Window/Help registered | ✅ 🍎 | Menu tests (every accelerator parses); shortcuts drive the real app on Linux. AppKit roles need a Mac. |
| Chrome non-selectable, arrow cursor, native scrollbars | ✅ | CSS. |
| WebKit's text context menu kept; native menus for tabs, links, images, sidebar rows | ✅ 🍎 | e2e checks menu items; NSMenu display needs a Mac. |
| Accessibility: Reduce Motion, Increase Contrast, VoiceOver labels, keyboard | ✅ | Roles/labels throughout; tab strip arrow keys; MathML for math. A VoiceOver pass needs a Mac. |
| Print ⌘P with a print stylesheet | ✅ 🍎 | e2e `print` (no chrome, white paper, whole document); the print panel is native. |
| Export ▸ HTML, self-contained | ✅ | e2e `readme` (images and KaTeX fonts inlined, no internal attributes). |
| Info.plist usage descriptions | ✅ | `src-tauri/Info.plist`. |
| App icon (ivory sheet + terracotta mark, macOS grid) | ✅ | `design/icon.svg` → `src-tauri/icons/`. |
| Liquid Glass `.icon` (Icon Composer) | ⏭ | Needs Xcode 26; not available here. The `.icns` is used meanwhile. |
| Help ▸ Folio Help (bundled help.md); Help ▸ Show Logs | ✅ | e2e `help` renders it; logs in `~/Library/Logs/Folio`. |
| Full shortcut list | ✅ | `menu.rs` table + webview handlers (⌘1–⌘9, ⌃⇥, ⌘=). |

## 11 · Settings window

| Requirement | Status | Evidence |
|---|---|---|
| Toolbar panes General/Appearance/Reading/Advanced, not resizable, remembers pane, live apply | ✅ | e2e `settings` (light/dark screenshots, theme applies live). |

## 12 · Architecture and security

| Requirement | Status | Evidence |
|---|---|---|
| Rust owns the filesystem; no fs plugin; narrow validated commands | ✅ | `capabilities/*.json`; `access.rs` tests. |
| Strict CSP; each relaxation noted | ✅ | e2e runs under the production CSP with zero violations; DECISIONS.md ▸ Security. |
| Capabilities limited to what each window uses | ✅ | Separate document/settings capabilities. |
| One typed IPC module | ✅ | `src/ipc/`. |
| Parsing never blocks the main thread | ✅ | Worker; speculative render. |

## 13 · Performance

Budgets: Finder double-click → rendered README < 500 ms cold, < 150 ms warm;
tab switch < 50 ms.

**macOS: not measured** — there was no Mac. `scripts/measure-launch.sh`
measures exactly these budgets from Folio's own log (cold: `open -b` →
rendered and shown; warm: open while running; tab switches and reloads with
`FOLIO_PERF=1`).

**Measured here**, as upper bounds on a slower stack:

*Real app, release build, Linux* — WebKitGTK 2.52.6 under Xvfb with software
rendering, 4 vCPU Xeon @ 2.1 GHz, no GPU; timings from Folio's own `perf:`
log (`FOLIO_PERF=1`), medians of 6 launches:

| Measure | Result | Budget (macOS) |
|---|---|---|
| Process spawn → README render committed | 365 ms | — |
| Process spawn → README window on screen | 588 ms (≈ 220 ms of it is WebKitGTK's first layout with software rendering) | < 500 ms cold |
| 4 files on the command line → the active one on screen | 581 ms (background tabs render after it) | — |
| Tab switch (12 switches across 4 documents, up to 1,140 lines) | median 19 ms, max 39 ms | < 50 ms |
| Live reload: file change event → re-rendered frame | median 16 ms, max 23 ms | — |

*Frontend only, Chromium harness* — the production bundle with mocked IPC
(`node e2e/startup.mjs`, `node e2e/run.mjs`):

| Measure | Result |
|---|---|
| Navigation start → README committed | median 190–207 ms |
| — of which: worker created / render requested / worker starts / render returned | 22 / 84 / 118 / 159 ms |
| All code blocks highlighted (progressive, after the content) | ≈ 0.55 s after commit on a first launch; the first TypeScript highlight drops from ~260 ms to ~160 ms once regex translations are cached |
| Tab switch, mounted tab (click → painted frame) | median 14 ms |
| Tab switch, evicted tab rebuilt from cached HTML | median 15 ms |
| Layout shift on the README fixture | CLS < 0.01 |

These stacks are slower than a Mac (no GPU, software compositing, a
2.1 GHz server core), so they're upper bounds, not a substitute for
`scripts/measure-launch.sh` on real hardware. The warm-open budget (< 150 ms
while running) is Mac-only: on macOS `open` hands the file to the running
app, while on Linux a second `folio` starts a new process.

## What needs a Mac

Run these on macOS 13+ before calling it done:

1. `pnpm tauri build --target universal-apple-darwin`, install, and check the
   bundle: `Info.plist` document types and imported UTI, the icon, ad-hoc
   signature (`codesign -dv`).
2. `scripts/measure-launch.sh` — cold and warm budgets; then switch tabs and
   save a document and run `--report`.
3. Default app: Settings ▸ General ▸ Make Default, then double-click `.md`,
   `.markdown` and `.mdown` files in Finder; the first-launch banner appears
   once.
4. Cold launch with 10 files selected in Finder → one window, ten tabs, no
   Welcome flash; `folio -` and `folio --split --line 120 file.md` with Folio
   quit and running.
5. Window chrome: traffic lights centered in the toolbar (also in full
   screen and on macOS 26), toolbar drag and double-click (System Settings ▸
   Desktop & Dock ▸ double-click action), no white flash in light and dark.
6. Native menus: every shortcut in Help, checkmarks and enabled states,
   Window menu listing, context menus on tabs, links, images and sidebar
   rows, ⌘-click on a tab.
7. ⌘O with files and folders together, Locate… for a moved file, Export ▸
   HTML save panel, Print, Open in Editor with VS Code and with TextEdit.
8. Session restore with "Close windows when quitting" on and off; quit with
   no windows open and reopen from the Dock.
9. VoiceOver pass over the toolbar, tabs, sidebar and document; Increase
   Contrast and Reduce Motion.
10. An iCloud Drive document that isn't downloaded yet.

## Follow-ups

- Liquid Glass app icon (`.icon` from Icon Composer, Xcode 26).
- Consider the WASM Oniguruma engine if first-launch highlighting needs to
  be faster still (it needs `'wasm-unsafe-eval'` in the CSP).
