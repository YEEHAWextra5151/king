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
| `folders.rs` | Folder listing for the Files sidebar and Open Quickly (`ignore` walker, Markdown only). |
| `paths.rs` | Canonicalization, Markdown/image/text classification, README lookup, stdin temp paths. |
| `themes.rs` | Custom theme folder listing + hot reload. |
| `editor.rs` | Editor detection and Open in Editor (never the default handler). |
| `cli_install.rs` | Install Command Line Tool (admin prompt, `~/.local/bin` fallback). |
| `macos.rs` | objc2 glue: NSOpenPanel (files + folders), default-app status & Make Default, NSDocumentController recents, window appearance/zoom/miniaturize, `AppleActionOnDoubleClick`, NSPasteboard rich copy, dataless flag, file icons, traffic-light metrics. No-op fallbacks elsewhere. |
| `commands.rs` | All `#[tauri::command]`s — thin, validated wrappers over the modules above. |
| `perf.rs` | Launch/render timing marks written to the log. |

## 4. Frontend modules (`src/`)

```
src/
  main.tsx                 tiny entry: start the worker, theme <html>, load app
  boot.ts                  boot data from Rust (settings, platform, metrics)
  ipc/                     typed commands + events (single source of truth)
  app/                     DocumentWindow, actions (menu/keyboard/context),
                           find controller, first-paint + perf logging
  store/                   workspace (tabs, MRU, closed tabs, sidebar, banners),
                           docs (document cache), settings (mirror of Rust's)
  render/
    prestart.ts            creates the worker before React evaluates
    worker.ts, renderer.ts markdown-it + plugins + KaTeX in a Web Worker
    markdown.ts, plugins/  markdown-it setup; source lines, anchors, front
                           matter, math, tables, task lists, images, fences
    highlight.ts           grammar names + plain rendering (cheap half)
    shikiCore.ts           Shiki core + JS regex engine (lazy chunk)
    regexCache.ts          regex translations kept in IndexedDB
    client.ts              main-thread worker client (supersede, dedupe)
    sanitize.ts            DOMPurify allowlist + trusted-slot injection
    blocks.ts              keyed block diff, source-line geometry
    mermaid.ts             lazy Mermaid, themed, rendered near viewport
  views/
    TabView.tsx            one tab: preview/code/split orchestration
    preview.ts             imperative document surface (render, scroll, find)
    codeview.ts            CodeMirror 6, read-only (lazy chunk)
    find.ts                CSS Custom Highlight API find (DOM fallback)
  chrome/                  Toolbar (tabs, view mode), Sidebar, FindBar,
                           OpenQuickly, Welcome, Banners, StatusBar, ImageZoom
  lib/                     paths, fuzzy, context menus, error log
  styles/                  tokens.css (Claude), themes.css (GitHub, Paper),
                           chrome.css, document.css, code.css, print.css
  settings/                Settings window (General/Appearance/Reading/Advanced)
```

## 5. IPC contract

All commands are declared in `src-tauri/build.rs` (`AppManifest::commands`) so
each gets an `allow-*` permission, and capabilities grant only what each
window kind uses. `src/ipc/index.ts` mirrors every command and event with
TypeScript types; nothing else calls `invoke`/`listen` directly.

### Commands (frontend → Rust)

Every path argument is checked in Rust against what the user opened (Finder,
the open panel, a drop Rust itself observed, the CLI, a deep link) or a
relative link/image from one of those documents.

| Command | Args | Returns | Notes |
|---|---|---|---|
| `take_window_init` | – | `WindowInit` | Once on mount: restored tabs, folder, sidebar, notices, first-launch banner. |
| `take_pending_opens` | – | `OpenRequest[]` | Drains this window's open queue. |
| `window_ready` | – | – | First layout/paint done → Rust shows the window. |
| `registry_update` | `WindowSnapshot` | – | Tabs, active tab, folder, menu state (Rust's authoritative copy). |
| `perf_mark` / `frontend_log` | `{ name }` / `{ level, message }` | – | Local log only. |
| `toolbar_double_click` / `start_window_drag` | – | – | Honors `AppleActionOnDoubleClick`. |
| `close_window` / `new_window` / `open_settings` | – | – | |
| `read_document` | `{ path, asText }` | `ReadResult` | Decoded text + metadata, `downloading`, or a calm error. |
| `resolve_link` | `{ from, href, root }` | `LinkTarget` | Classifies (markdown/text/directory/other/external/missing/blocked) and grants. |
| `allow_images` | `{ doc, srcs[], root }` | `Record<src, {path,width,height} \| null>` | Grants each existing image file to the asset scope. |
| `image_data_urls` | `{ paths[] }` | `Record<path, dataUrl>` | Export ▸ HTML (granted images only). |
| `list_folder` | `{ root }` | `FolderListing` | `ignore` walker, Markdown only, ≤ 20 000 files. |
| `open_dropped` | `{ paths[], insertAt }` | – | Only paths Rust saw in the native drop event. |
| `open_granted` | `{ path, newWindow, view }` | – | Paths already granted (links, sidebar, recents, Open Quickly). |
| `show_open_panel` / `locate_file` | `{ foldersOnly }` / `{ path }` | – / `string \| null` | Native panels. |
| `move_tab_to_new_window` / `merge_windows` / `list_open_documents` | … | | |
| `reveal_in_finder` / `open_external` / `open_in_editor` / `list_editors` / `show_logs_folder` | … | | `open_external`: http, https, mailto only. |
| `popup_menu` / `popup_path_menu` | `{ token, items }` / `{ path }` | – | Native NSMenus; choice returns as `context-menu`. |
| `print_window` / `export_html` / `copy_to_clipboard` | … | | Print panel; save panel; plain + HTML pasteboard. |
| `get_settings` / `update_settings` / `reset_settings` | `Partial<Settings>` | `Settings` | Broadcasts `settings-changed`. |
| `get_recents` / `clear_recents` / `get_reading_position` / `save_reading_position` | … | | |
| `list_themes` / `open_themes_folder` | – | `CustomTheme[]` | User CSS themes. |
| `default_app_status` / `make_default_app` / `dismiss_default_app_banner` | – | `DefaultAppStatus` | LaunchServices. |
| `install_cli` | – | `CliInstallResult` | Symlink with the admin prompt, `~/.local/bin` fallback. |

### Events (Rust → frontend)

| Event | Payload | Target |
|---|---|---|
| `documents-opened` | `{}` (signal: drain queue) | one window |
| `document-changed` | `{ path, modifiedMs }` | windows that show `path` |
| `document-removed` | `{ path }` | windows that show `path` |
| `menu-action` | `{ action, arg? }` | focused window |
| `context-menu` | `{ token, item }` | the window that asked |
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
| Tab switch | < 50 ms | Store activation → the painted frame, logged with `FOLIO_PERF=1`. |

Levers (as built): a 6 KB entry chunk that starts the render worker before
React loads; CodeMirror, Mermaid, KaTeX and Shiki's core are lazy chunks; the
first render is requested as soon as the document is read and the worker
warms its parser while idle; runtime grammars on the JavaScript regex engine
with translations cached in IndexedDB; hidden windows shown as soon as the
first document is laid out; cached per-block output; inactive tabs keep
their layout. Measured numbers are in ACCEPTANCE.md.

## 10. Milestones

All built; see ACCEPTANCE.md for what was verified where.

1. Scaffold, API research, this plan. ✔︎
2. Rust core: open queue, documents, access, registry, commands, windows. ✔︎
3. Render pipeline: worker, plugins, Shiki, KaTeX, Mermaid, sanitizer. ✔︎
4. Themes: tokens, three themes, custom themes, no-flash boot. ✔︎
5. Tabs & windows: tab bar, dedupe, session, welcome. ✔︎
6. Code view + Split + scroll sync. ✔︎
7. Navigation: sidebar, Open Quickly, find, links & history, zoom, copy. ✔︎
8. Live reload. ✔︎
9. Native menus, settings window, print/export, help. ✔︎
10. Default app, file types, CLI, deep links, icon, bundling. ✔︎
11. Tests, performance numbers, acceptance checklist. ✔︎

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| This work is built on Linux; macOS-only code can't run here. | All objc2 code is behind `cfg(target_os = "macos")` and type-checked with `cargo check --target aarch64-apple-darwin`; Linux fallbacks let the whole app run under WebKitGTK for end-to-end checks. What still needs a Mac is listed in the acceptance report. |
| `RunEvent::Opened` arrives before setup on cold launch. | Queue in pre-registered state; windows created only in setup. |
| White flash on window creation. | Hidden windows, native background from theme (`macos-private-api` → `drawsBackground = NO`), inline critical CSS, theme resolved in an initialization script before first paint. |
| Shiki cold-start cost (first TypeScript highlight ≈260 ms, ≈160 ms with cached translations). | Progressive highlighting: plain code first, colors patched in; regex translations cached in IndexedDB. |
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
* e2e (`e2e/run.mjs`, Chromium + mocked IPC + the production CSP): the real
  frontend bundle — rendering, hostile HTML, tabs, views, sidebar, find,
  Open Quickly, welcome, errors, large files, live reload, restore,
  settings, zoom, print, export — with screenshots for visual review;
  `e2e/startup.mjs` breaks down a cold start.
* The real app (Linux build, WebKitGTK under Xvfb) driven with xdotool for
  end-to-end IPC, CSP, deep links, folders, live reload, session restore and
  timing.
* `scripts/measure-launch.sh` on a Mac for the launch budgets.
