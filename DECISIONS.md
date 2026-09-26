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
- **Precompiled grammars on Shiki's raw JavaScript regex engine**
  (`@shikijs/langs-precompiled`). This avoids a WASM download/compile (~55 ms)
  and the regex translation step (~100 ms for TypeScript). Grammars are still
  loaded per language, only for fences present in the document.
- **Progressive highlighting.** Even precompiled, the first TypeScript block
  costs ~150 ms of cold tokenizer time. A code block whose grammar isn't
  loaded yet renders as plain monospace text immediately, and colors are
  patched in when ready. The text is identical, so there's no layout shift.
