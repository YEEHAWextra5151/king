# Folio — Plan

Folio is a read-only Markdown viewer for macOS, built with Tauri 2. The bar is
Preview.app: instant, quiet, keyboard-driven, and unmistakably native. This file
describes the architecture, the IPC contract, the module layout, and the risks.
Non-obvious calls are logged in `DECISIONS.md`.

## 1. Shape of the app

```
┌──────────────────────────── Rust (src-tauri) ─────────────────────────────┐
│ open_queue ─► router ─► registry (windows ⇄ tabs, authoritative)          │
│   ▲  RunEvent::Opened / argv / deep link / drops / open panel             │
│ access (what the frontend may read) ◄── documents (decode, stat, iCloud)  │
│ watcher (notify, parent-dir watches, poll fallback) ─► document-changed   │
│ session · recents · settings (tauri-plugin-store JSON in App Support)     │
│ menu (full NSMenu bar, state per focused window) · macos (objc2 glue)     │
│ windows (create hidden → show after first paint, cascade, frames)         │
└────────────────────────── narrow commands + events ───────────────────────┘
┌────────────────────── Frontend (one webview per window) ──────────────────┐
│ React 19 chrome: toolbar/tab bar · sidebar · find · Open Quickly · banners│
│ Zustand workspace store per window (tabs are app state, not webviews)     │
│ Preview pane: imperative DOM (sanitized HTML, keyed block diff)           │
│ Code pane: CodeMirror 6, read-only, lazy-loaded                           │
│ Render worker: markdown-it + plugins, Shiki (lazy grammars), KaTeX (lazy) │
└───────────────────────────────────────────────────────────────────────────┘
```

* **One webview per window.** Tabs live in a Zustand store; the five most
  recently used tabs stay mounted (hidden); older tabs are rebuilt from cached,
  already-sanitized HTML.
* **Rust owns the filesystem.** No fs plugin is exposed. The frontend can only
  read documents the user opened (Finder, open panel, drop, CLI, deep link),
  files inside a folder the user opened, relative links from those, and the
  bundled help file.
* **Windows are created by Rust, hidden,** with the native background already
  set to the theme's surface color. The frontend paints, then calls
  `window_ready`, and only then does Rust show the window. No white flash, and
  no empty welcome window when launched with files.

## 2. Process & window lifecycle

1. `main` → `Builder` with managed state (`OpenQueue`, `Registry`, `Access`,
   `Settings`, …) registered **before** the event loop starts, because on a
   cold launch AppKit delivers `application:openURLs:` (→ `RunEvent::Opened`)
   *before* `applicationDidFinishLaunching:` (→ `RunEvent::Ready` → `setup`).
   Verified in tao 0.35 / tauri 2.11 sources.
2. `RunEvent::Opened` before Ready → URLs are pushed into `OpenQueue`.
   After Ready → routed immediately.
3. `setup` (Ready): load settings, restore the session (per setting), route
   everything in `OpenQueue`, and only if nothing was restored or opened, show
   the Welcome window after a short grace period (in case an Apple Event
   arrives late).
4. Every document window gets a `WindowInit` (tabs, folder, sidebar, frame)
   held in Rust; the frontend pulls it on mount (`take_window_init`) and then
   drains its per-window open queue (`take_pending_opens`). Later opens are
   pushed to the queue and signalled with a `documents-opened` event, so
   nothing is lost if the event races the mount.
5. Closing the last window keeps the app running (`ExitRequested` with no
   code is prevented unless it came from Quit). `RunEvent::Reopen` with no
   visible windows opens the Welcome window.
6. Settings is a separate fixed-size window (label `settings`).

Window labels: `doc-<n>` (monotonic), `settings`.

## 3. Rust modules (`src-tauri/src`)

| Module | Responsibility |
|---|---|
| `lib.rs` | Builder, plugins, state, run-loop events (`Opened`, `Reopen`, `ExitRequested`, window events). |
| `open_queue.rs` | Cold-launch queue + per-window pending queues. `OpenRequest` model. |
| `router.rs` | Classifies targets (markdown / text / folder / missing), dedupes against the registry, picks or creates the target window, grants access, notes recents. |
| `documents.rs` | `read_document`: stat, dataless (iCloud) detection, size limits, BOM/UTF-8/UTF-16/Windows-1252 decoding, CRLF normalization, text sniffing for code files. |
| `access.rs` | Access policy: granted files, granted folders, link resolution, image grants into the asset-protocol scope (file by file). |
| `registry.rs` | Authoritative windows → tabs map reported by each frontend; dedupe lookups, focus order, menu state, session snapshot, Merge All Windows. |
| `watcher.rs` | notify + notify-debouncer-full (~100 ms) on parent directories, refcounted per file, poll fallback on network volumes, mtime re-check on activation. |
| `session.rs` | Save/restore windows, tabs, frames; System/Always/Never policy (`NSQuitAlwaysKeepsWindows`). |
| `recents.rs` | Open Recent list, reading positions (LRU), `noteNewRecentDocumentURL:`. |
| `settings.rs` | Typed settings with defaults, persisted with tauri-plugin-store, broadcast via `settings-changed`. |
| `menu.rs` | Full menu bar; ids → actions; enabled/checked state from the focused window. |
| `windows.rs` | Document/settings window builders (hidden, background color, appearance, traffic lights, navigation guards), cascade, frames. |
| `deeplink.rs` | Parse and validate `folio://open?...` (untrusted input). |
| `themes.rs` | Custom theme folder listing + hot reload. |
| `editor.rs` | Editor detection and Open in Editor (never the default handler). |
| `cli_install.rs` | Install Command Line Tool (admin prompt, `~/.local/bin` fallback). |
| `macos.rs` | objc2 glue: NSOpenPanel (files + folders), default-app status & Make Default, NSDocumentController recents, window appearance/zoom/miniaturize, `AppleActionOnDoubleClick`, NSPasteboard rich copy, dataless flag, file icons, traffic-light metrics. No-op fallbacks elsewhere. |
| `commands.rs` | All `#[tauri::command]`s — thin, validated wrappers over the modules above. |
| `perf.rs` | Launch/render timing marks written to the log. |

## 4. Frontend modules (`src/`)

```
src/
  main.tsx                 boot: pick DocumentWindow or Settings app
  ipc/                     typed commands + events (single source of truth)
  store/workspace.ts       tabs, MRU, closed-tab stack, sidebar, folder, find
  store/settings.ts        settings mirror (Rust is the owner)
  render/
    worker.ts              markdown-it + plugins + Shiki + KaTeX (Web Worker)
    markdown.ts            markdown-it setup (shared by worker + tests)
    plugins/               source lines, anchors, front matter, math, tables…
    highlight.ts           Shiki core + JS engine + precompiled grammars
    client.ts              main-thread worker client, request coalescing
    sanitize.ts            DOMPurify allowlist + trusted-slot injection
    blocks.ts              keyed top-level block diff, change tint
    mermaid.ts             lazy Mermaid, themed, rendered near viewport
  views/
    PreviewPane.tsx        imperative document surface
    CodePane.tsx           CodeMirror 6 (lazy module codemirror/*.ts)
    SplitView.tsx          divider + scroll sync
  chrome/                  Toolbar, TabBar, ViewModeControl, Sidebar,
                           FindBar, OpenQuickly, Welcome, Banner, StatusBar
  lib/                     paths, fuzzy, hash, scroll anchors, find, clipboard
  styles/                  tokens.css (Claude), github.css, paper.css,
                           chrome.css, document.css, print.css
  settings/                Settings window app (General/Appearance/Reading/Advanced)
```

## 5. IPC contract

All commands are declared in `src-tauri/build.rs` (`AppManifest::commands`) so
each gets an `allow-*` permission, and capabilities grant only what each
window kind uses. `src/ipc/index.ts` mirrors every command and event with
TypeScript types; nothing else calls `invoke`/`listen` directly.

### Commands (frontend → Rust)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `take_window_init` | – | `WindowInit` | Called once on mount. |
| `take_pending_opens` | – | `OpenRequest[]` | Drains this window's queue. |
| `window_ready` | `{ perf }` | – | First paint done → Rust shows the window. |
| `registry_update` | `WindowSnapshot` | – | Tabs, active tab, folder, menu state. |
| `read_document` | `{ path }` | `DocumentPayload` | Access-checked; may return `downloading`. |
| `resolve_link` | `{ from, href }` | `LinkTarget` | Classifies + grants relative targets. |
| `allow_images` | `{ doc, srcs[] }` | `Record<src, url \| null>` | Grants each existing image file to the asset scope. |
| `list_folder` | `{ root }` | `FolderNode` | `ignore` walker, Markdown only. |
| `open_paths` | `{ paths[], insertAt?, newWindow? }` | – | Only for paths Rust saw dropped. |
| `show_open_panel` | `{ folders? }` | – | Native NSOpenPanel, routed like Finder opens. |
| `locate_file` | `{ path }` | `string \| null` | Open panel for a moved file. |
| `reveal_in_finder` | `{ path }` | – | Access-checked. |
| `open_external` | `{ url }` | – | http, https, mailto only. |
| `open_in_editor` | `{ path, line? }` | – | Configured/auto-detected editor. |
| `popup_tab_menu` / `popup_path_menu` | … | – | Native menus built in Rust. |
| `new_window` / `move_tab_to_new_window` | `TabState` | – | |
| `print_window` | – | – | Native print panel (includes Save as PDF). |
| `export_html` | `{ html, suggestedName }` | – | Save panel, writes a new file. |
| `copy_to_clipboard` | `{ text, html? }` | – | NSPasteboard: plain + HTML. |
| `get_settings` / `update_settings` | `Partial<Settings>` | `Settings` | Broadcasts `settings-changed`. |
| `get_recents` | – | `RecentItem[]` | |
| `get_reading_position` / `save_reading_position` | `{ path, … }` | | |
| `list_themes` | – | `CustomTheme[]` | CSS text of user themes. |
| `default_app_status` / `make_default_app` | – | `DefaultAppStatus` | |
| `install_cli` | – | `CliInstallResult` | |
| `toolbar_double_click` | – | – | Honors `AppleActionOnDoubleClick`. |
| `start_window_drag` | – | – | Empty toolbar space. |
| `perf_mark` | `{ name }` | – | Timing log. |

### Events (Rust → frontend)

| Event | Payload | Target |
|---|---|---|
| `documents-opened` | `{}` (signal: drain queue) | one window |
| `document-changed` | `{ path, modifiedMs }` | windows that show `path` |
| `document-removed` | `{ path }` | windows that show `path` |
| `menu-action` | `{ action, arg? }` | focused window |
| `settings-changed` | `Settings` | all windows |
| `themes-changed` | `CustomTheme[]` | all windows |
| `recents-changed` | `RecentItem[]` | all windows |
| `window-state` | `{ fullscreen }` | one window |

## 6. Rendering pipeline

1. **Read** (Rust): bytes → text (BOM/UTF-8/UTF-16/Windows-1252), `\r\n`/`\r`
   → `\n`, metadata. Files > 10 MB open in Code view with an offer to render.
2. **Parse** (worker): `md.parse` once; collect fence languages, math, Mermaid.
   Load KaTeX only when math exists. Grammars already loaded highlight
   synchronously; missing ones render as plain code first and arrive as a
   follow-up patch (text is identical, so there is no layout shift).
3. **Render** (worker): block tokens carry `data-source-line` /
   `data-source-line-end` from `token.map` (VS Code's approach). Shiki and
   KaTeX output are trusted (they escape their input) and travel in a side
   table; the HTML contains `<folio-slot data-k="nonce:n">` placeholders.
   Per-block outputs are cached by content hash.
4. **Sanitize** (main): DOMPurify with a GitHub-like allowlist; `style`
   attributes are dropped from document HTML (table alignment becomes
   `align`); links and images are rewritten (relative images → asset URLs
   after `allow_images`); remote images optionally blocked. Then slots are
   filled with the trusted HTML.
5. **Commit** (main): top-level blocks are diffed by hash; unchanged DOM nodes
   are kept (images and diagrams don't flicker), changed ones are replaced and
   tinted. Scroll position is anchored to the top visible block's source line.
6. **Decorate** (main, lazy): Mermaid near the viewport (IntersectionObserver),
   code-block copy buttons, image zoom, heading outline, find highlights.

## 7. Persistence (`~/Library/Application Support/Folio/`)

| File | Contents |
|---|---|
| `settings.json` | Settings (store plugin). |
| `session.json` | Windows, frames, tabs, per-tab view state. |
| `recents.json` | Open Recent + reading positions (LRU 500). |
| `themes/*.css` | User themes (hot-reloaded). |

Logs: `~/Library/Logs/Folio/`. Standard Input temp files:
`$TMPDIR/dev.yourname.folio/stdin/`, deleted on next launch.

## 8. Security model

* Strict CSP; `style-src 'unsafe-inline'` is the one relaxation (KaTeX, Shiki
  and Mermaid emit inline styles). Tauri's automatic style nonce is disabled so
  that relaxation actually applies; scripts keep Tauri's nonces.
* Document HTML goes through DOMPurify: no scripts, iframes, forms, event
  handlers, `style`, or non-http(s)/mailto/relative URLs.
* The webview never navigates: `on_navigation` allows only the app origin,
  `on_new_window` denies, link previews are disabled, and link clicks are
  routed explicitly.
* Deep links are untrusted: canonicalize, open only existing Markdown files
  or folders.
* Asset protocol scope starts empty; each referenced image file is granted
  individually when its document renders.
* Capabilities: document windows get only the app commands they use plus the
  event/window/menu permissions required by the chrome; the settings window
  gets settings commands only.

## 9. Performance budgets and how they are measured

| Budget | Target | Instrument |
|---|---|---|
| Cold: Finder double-click → rendered README | < 500 ms | `perf.rs` marks from process start: `opened`, `window-created`, `dom-ready`, `document-read`, `render-committed`, `window-shown`; `scripts/measure-launch.sh` drives `open` on macOS. |
| Warm: open while running | < 150 ms | `Opened` → `render-committed`. |
| Tab switch | < 50 ms | `performance.now()` around activation, logged in dev builds. |

Levers: tiny main chunk (CodeMirror, Mermaid, KaTeX lazy); worker spawned at
boot, before the document is read; precompiled Shiki grammars on the raw JS
regex engine (no WASM); hidden windows shown after first paint; cached
per-block output.

## 10. Milestones

1. Scaffold, API research, this plan. ✔︎
2. Rust core: open queue, documents, access, registry, commands, windows.
3. Render pipeline: worker, plugins, Shiki, KaTeX, Mermaid, sanitizer.
4. Themes: tokens, three themes, custom themes, no-flash boot.
5. Tabs & windows: tab bar, dedupe, session, welcome.
6. Code view + Split + scroll sync.
7. Navigation: sidebar, Open Quickly, find, links & history, zoom, copy.
8. Live reload.
9. Native menus, settings window, print/export, help.
10. Default app, file types, CLI, deep links, icon, bundling.
11. Tests, performance numbers, acceptance checklist.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| This work is built on Linux; macOS-only code can't run here. | All objc2 code is behind `cfg(target_os = "macos")` and type-checked with `cargo check --target aarch64-apple-darwin`; Linux fallbacks let the whole app run under WebKitGTK for end-to-end checks. What still needs a Mac is listed in the acceptance report. |
| `RunEvent::Opened` arrives before setup on cold launch. | Queue in pre-registered state; windows created only in setup. |
| White flash on window creation. | Hidden windows, native background from theme (`macos-private-api` → `drawsBackground = NO`), inline critical CSS, theme resolved in an initialization script before first paint. |
| Shiki cold-start cost (first TypeScript highlight ≈150 ms). | Progressive highlighting: plain code first, colors patched in; worker pre-warmed at boot. |
| DOMPurify cost on very large documents. | Trusted slots keep Shiki/KaTeX output out of the sanitizer; >10 MB files open in Code view. |
| WKWebView swallowing menu shortcuts (CodeMirror keymaps). | Minimal CodeMirror keymap; menu shortcuts never `preventDefault`ed. |
| Atomic saves breaking watches. | Watch parent directories, compare mtime/size after debounce. |
| Deep links / dropped paths as an attack surface. | Canonicalize + type check in Rust; drops are recorded by Rust from the native drag-drop event before the frontend may open them. |
| Mermaid size and CVE history. | Dynamic import only when needed, `securityLevel: "strict"`, output re-sanitized as SVG. |
| Tauri API drift. | Checked against the tauri 2.11.6 / tauri-utils 2.9.3 / tauri-bundler 2.9.4 sources; deviations noted in DECISIONS.md. |

## 12. Testing

* Rust unit tests: decoding, deep-link parsing, access policy, link
  resolution, folder listing, registry/dedupe, session round-trip, watcher
  classification.
* Vitest: GitHub-compatible heading ids, alerts, footnotes, task lists, math
  errors, front matter, sanitizer (malicious inputs), fuzzy matcher, scroll
  interpolation, block diff.
* Playwright (Chromium, mocked IPC): the real frontend bundle — rendering,
  tabs, split, find, theme switching, screenshots for visual review.
* The real app under Xvfb/WebKitGTK for end-to-end IPC and timing.
