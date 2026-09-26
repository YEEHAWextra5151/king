# Decisions

Non-obvious calls made while building Folio, newest last within each section.
Where the spec named an API or config key that has changed in current Tauri, the
entry says so and names what was used instead.

## Versions

- **Tauri 2.11.6** (CLI 2.11.5, tauri-utils 2.9.3, tauri-bundler 2.9.4,
  wry 0.55.1, tao 0.35.3). APIs were checked against these sources, not docs
  from memory.
- **markdown-it 15.0.2.** Latest major; it ships its own types (so no
  `@types/markdown-it`) and fixes several quadratic-time issues. The footnote,
  emoji and GitHub-alerts plugins work unchanged with it.
- **linkify-it 6 (via markdown-it 15) no longer links `www.` URLs by
  default.** GFM does link `www.example.com` (but not bare `example.com`), so
  fuzzy links are enabled and then filtered down to the `www.` form.
- **KaTeX 0.18.9.** Its CSS classes gained a prefix in 0.18. That only affects
  custom selectors, and we ship KaTeX's own stylesheet.
- **Mermaid 11.17.2, not 12.0.0.** Mermaid 12 is two weeks old, requires Safari
  17.4+, and switches the default layout to ELK and the default theme to
  `redux-color`, so diagrams would stop matching GitHub. Our macOS 13 floor
  can ship with an older WebKit.
- **TypeScript 7** (native compiler) for type-checking only. Vite/Vitest do
  their own transpilation.

## Platform and Tauri

- **`app.macOSPrivateApi: true` + the `macos-private-api` feature.** This is
  the only way wry sets `drawsBackground = NO` on the WKWebView, which makes
  the native window background (the theme's surface color) show through
  before the first paint. Without it you get a white flash. It uses a private
  WebKit key, which is fine: Folio is distributed with Developer ID, not
  through the App Store.
- **No windows in `tauri.conf.json`.** On a cold launch AppKit delivers
  `application:openURLs:` before `applicationDidFinishLaunching:`, which is
  also before Tauri runs `setup`. Windows are created in Rust once we know
  whether files were opened, so a launch with files never shows the Welcome
  window. The open queue is managed state registered on the `Builder`, so it
  exists when those early events arrive.
- **Windows start hidden and are shown after the frontend's first paint**
  (`window_ready`). A 1.5 s fallback shows the window anyway if the frontend
  fails.
- **Own toolbar drag and double-click handling instead of
  `data-tauri-drag-region`.** Tauri's drag script always toggles maximize on
  double-click. We need to honor `AppleActionOnDoubleClick` (Zoom, Minimize,
  Fill, or nothing).
- **Traffic lights:** `trafficLightPosition` takes an inset whose meaning
  depends on AppKit's button metrics. It is computed at startup from an
  offscreen window's real close-button frame, so the buttons center in the
  44 px toolbar on every macOS version (including 26's larger controls).
  Tauri has no runtime setter, so it's fixed per window at creation. The
  fallback is `(16, 20)`.
- **The deep-link plugin is used for scheme registration**
  (`plugins.deep-link.desktop.schemes` → `CFBundleURLTypes`). On macOS both
  file opens and `folio://` URLs arrive through `RunEvent::Opened`, so one
  handler routes both. That keeps cold-launch ordering identical for the CLI
  and Finder. (The plugin also re-emits every `Opened` URL as
  `deep-link://new-url`; the frontend doesn't listen to it.)
- **`src-tauri/Info.plist` holds only keys the config can't express:**
  `UTImportedTypeDeclarations`, the folder-access usage descriptions and
  `LSMultipleInstancesProhibited`. The bundler merges user plist keys
  shallowly, replacing whole top-level keys, so declaring
  `CFBundleDocumentTypes` there would silently drop the config's file
  associations. Both document types, Markdown (Viewer) and `public.folder`
  (Viewer, rank `None`), are therefore in `bundle.fileAssociations`.
- **Open panel via NSOpenPanel (objc2), not tauri-plugin-dialog.** The
  plugin (rfd) can pick files *or* folders, but ⌘O must allow both in one
  panel. The dialog plugin is still used for the save panel (Export HTML),
  Locate…, and message dialogs.

## Security

- **`style-src 'unsafe-inline'`** is the one CSP relaxation. KaTeX, Shiki and
  Mermaid all emit inline styles. Tauri normally appends a nonce to
  `style-src`, which makes browsers ignore `'unsafe-inline'`, so
  `dangerousDisableAssetCspModification: ["style-src"]` is set. Scripts keep
  Tauri's nonce-based `script-src`.
- **The other CSP sources, and why:** `img-src https: http:` because remote
  images a document references are shown (Settings can block them; the
  sanitizer then drops their `src`); `img-src data:` and `font-src data:`
  because Vite inlines small assets (a few KaTeX fonts, icons) as data URLs;
  `asset:`/`http://asset.localhost` for granted local images;
  `connect-src ipc: http://ipc.localhost` for Tauri's IPC only (there is no
  other network access); `worker-src 'self'` for the render worker;
  `object-src`, `frame-src`, `media-src`, `base-uri` and `form-action` are
  `'none'`. A raw `<base>` tag is removed before sanitizing, because even
  parsing one in DOMPurify's document trips `base-uri 'none'`.
- **`style` attributes are stripped from document HTML** (GitHub does the
  same). This stops a README from overlaying the app's chrome with
  `position: fixed`. Generated output that needs inline styles (Shiki, KaTeX)
  never goes through that path: it travels as *trusted slots*, filled in
  after sanitization and keyed by a per-render random nonce the document
  can't guess. markdown-it's `style="text-align:…"` on table cells is
  rewritten to `align`.
- **Image access is granted file by file, not folder by folder.** When a
  document renders, each local image it references (including `../` and
  absolute paths) is checked (it must exist and have an image extension) and
  added to the asset-protocol scope individually. This is narrower than
  granting the document's folder. It also covers `docs/README.md` pointing
  at `../assets/logo.png`, which a folder grant would miss.

## Rendering

- **Shiki uses its CSS-variables theme** (`createCssVariablesTheme`) rather
  than two baked-in hex themes. Every token becomes
  `color: var(--shiki-token-keyword)` and so on. Light/dark switching still
  needs no re-render, and the GitHub, Paper and user themes can restyle code
  too. The Claude theme defines those variables from the single syntax
  palette shared with CodeMirror.
- **Runtime grammars on Shiki's JavaScript regex engine, not precompiled
  ones.** `@shikijs/langs-precompiled` emits regexes with the `v` flag,
  which needs Safari 17+; macOS 13's WebKit may be older. Runtime
  translation (oniguruma-to-es, target detected from this WebKit) works
  everywhere and still avoids WASM, so `script-src` needs no
  `'wasm-unsafe-eval'`. Grammars are loaded per language, only for fences
  present in the document, and Shiki's core itself is a lazy chunk.
- **Progressive highlighting.** The first TypeScript block costs ~260 ms
  cold (measured in Node; ~0.55 s from first commit to all code colored in
  the Chromium harness). A code block whose grammar isn't loaded yet renders
  as plain monospace text immediately, and colors are patched in when
  ready. The text is identical, so there's no layout shift.
- **Regex translations are kept in IndexedDB** (`regexCache.ts`), keyed by
  the oniguruma-to-es version and the regex features this WebKit supports.
  Translating is most of the cold cost; with saved translations the first
  TypeScript highlight drops from ~260 ms to ~160 ms (the rest is the regex
  engine compiling and the tokenizer warming up). `oniguruma-to-es` is a
  direct dependency, pinned to the version Shiki uses. The WASM Oniguruma
  engine would be faster still but needs a CSP relaxation; not worth it
  while highlighting is progressive.
- **KaTeX runs in the worker, lazily,** only when a document has math, with
  `output: "htmlAndMathml"` (VoiceOver reads the MathML). Its stylesheet is
  loaded on the main thread before the first commit that needs it, and
  prefetched as soon as the source contains `$` or a math fence.
- **Mermaid renders near the viewport** (IntersectionObserver, 1000 px
  margin), serialized (Mermaid isn't reentrant), `securityLevel: "strict"`,
  `theme: "base"` with variables from the active theme, and its SVG is
  sanitized again (no `<a>`, scripts or foreign links) before insertion.
- **Images reserve their space.** `allow_images` returns each local image's
  dimensions (read from the file header with `imagesize`), which become
  `width`/`height` attributes, so nothing below moves when images decode.
  Images load eagerly (not `loading=lazy`): a restored reading position
  stays put, and a "sticky anchor" re-applies the position for 2.5 s while
  images above it load, unless the reader scrolls.
- **Live reload keeps the reader's place by DOM identity.** The top visible
  block is remembered before the commit; if the diff keeps that element,
  its offset is restored exactly. If it changed, the source line is
  shifted by however far the nearest surviving block above it moved. At
  the very top or bottom, the view stays at the top or bottom.
- **Double-clicking a rendered block switches the tab to Code view at that
  line** (in Split, the Code pane scrolls and flashes the line instead).

## Frontend architecture and performance

- **The entry chunk is tiny.** `main.tsx` only starts the render worker,
  applies the theme to `<html>` and dynamically imports the document or
  settings app. The worker starts ~15 ms earlier than when it was created
  after React evaluated.
- **Speculative first render.** When a Markdown document is read, its
  render request is sent to the worker right away; the view's identical
  request (same text and options) shares the result. The worker also parses
  a small sample while idle, so the first real parse runs on warm code
  (~47 ms → ~14 ms for the README fixture in Chromium).
- **Hidden windows get no animation frames, and their timers are
  throttled** (seen in WebKitGTK; WKWebView behaves the same for ordered-out
  windows). So a hidden window forces layout and reports `window_ready`
  synchronously; only an already-visible window waits for a painted frame.
  Before this, every cold launch waited for Rust's 1.5 s fallback. For the
  same reason Code view scrolls with CodeMirror's `scrollIntoView` (applied
  after it measures), and a programmatic scroll is recognized by where it
  lands, not by a time window.
- **Inactive tabs stay mounted and laid out (`visibility: hidden`),** not
  `display: none`: switching back is a repaint and scroll positions
  survive. `content-visibility: hidden` was tried and dropped: WebKit laid
  the tab out again on every switch (114 ms vs 31 ms for a 1,100-line
  document in WebKitGTK), and it saved little on resize because the reading
  width caps line length. Up to five recently used tabs stay mounted; older
  ones keep their rendered HTML (and block hashes) and are rebuilt from it
  in ~15 ms.
- **Events are always listened to on the current webview window.** Tauri's
  global `listen()` also receives events emitted to other windows.
- **Notices are floating banners over the document** (moved/deleted file,
  large file, encoding fallback, missing link target), never inserted above
  it, so content doesn't shift.

## Chrome and accessibility

- **White text sits on `--accent-fill` (#B4532F), not the accent
  (#D97757).** White on #D97757 is 3.1:1, under WCAG AA for text; on
  #B4532F it's 5:1. The accent itself stays for strokes, checkboxes and the
  selection tint. Two syntax colors were darkened slightly to reach 4.5:1 on
  the recessed code background: keyword #B4532F → #AE502D, comment #73726C →
  #6C6B66.
- **The outline highlights the heading you clicked** until you scroll, and
  the last heading when scrolled to the very end (short last sections can't
  reach the top).
- **Open Quickly matches file names; folders only when the query contains
  a slash.** Matching full paths made nearly everything match in deep trees.

## CLI, deep links, logging

- **`folio` is a POSIX `sh` script** (no runtime to install, works with
  macOS's bash 3.2 `sh`). Plain paths go through `open -b`, exactly like
  Finder, so cold and warm launches take the same route. Options travel in a
  percent-encoded `folio://open` link, also via `open -b` so the right app
  gets it even if another app claims the scheme. A Rust test runs the script
  against a stub `open` and round-trips the link through the deep-link
  parser.
- **Deep links stay strict:** at least one existing Markdown file or folder
  is required, so `folio --new-window` without a path is rejected by the
  script instead of adding a "new empty window" action to the scheme.
- **Standard Input** is written to `$TMPDIR/dev.yourname.folio/stdin/` and
  opened with `stdin=1`, which Rust honors only for files in that directory;
  such tabs are titled "Standard Input", stay out of Recents and session
  restore, and are deleted on the next launch.
- **Open in Editor passes the line only where the editor has a documented
  URL for it** (VS Code, Cursor). Zed, Sublime Text and BBEdit get the file.
- **Frontend errors go to Folio's local log** (`frontend_log`), rate-limited
  per window. Nothing is sent anywhere; Help ▸ Show Logs opens the folder.
- **`FOLIO_PERF=1` adds tab-switch and live-reload timings** to the log;
  launch and open marks are always logged (one line each).
