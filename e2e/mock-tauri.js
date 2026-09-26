/*
 * A mock Tauri runtime for driving the real frontend bundle in a browser.
 * Injected before any page script (Playwright addInitScript) together with
 * `window.__MOCK_FILES__` (virtual path → text) and `window.__MOCK_SCENARIO__`.
 * Implements Folio's commands against an in-memory file system, and the
 * event plugin, so tests can emit Rust events (document-changed, …).
 */
(function () {
  const files = Object.assign({}, window.__MOCK_FILES__ || {});
  const scenario = Object.assign({ label: "doc-1", kind: "document", pending: [], init: {}, settings: {}, recents: [] }, window.__MOCK_SCENARIO__ || {});
  const ROOT = scenario.root || "/Users/reader/Projects/sample";
  const IMAGES = { svg: [640, 220], png: [800, 600] };

  const settings = Object.assign(
    {
      openFilesIn: "tabs",
      sessionRestore: "system",
      defaultViewMode: "preview",
      rememberModePerFile: false,
      theme: "claude",
      appearance: "system",
      fontFamily: "serif",
      fontSize: 17,
      lineHeight: 1.65,
      readingWidth: "medium",
      frontMatter: "hidden",
      highlightChanges: true,
      statusBar: false,
      textZoom: 1,
      softWrap: true,
      remoteImages: true,
      editor: "auto",
      defaultAppBannerShown: true,
      lastSettingsPane: "general",
      lastWindowSize: null,
    },
    scenario.settings,
  );

  window.__FOLIO_BOOT__ = {
    label: scenario.label,
    kind: scenario.kind,
    platform: "macos",
    version: "0.1.0",
    settings,
    customThemeCss: null,
    trafficLights: { x: 16, y: 20 },
    toolbarHeight: 44,
  };

  const calls = [];
  const listeners = new Map();
  const callbacks = new Map();
  let pending = scenario.pending.slice();
  let registry = null;
  const positions = {};
  let recents = scenario.recents.slice();

  const basename = (p) => p.replace(/\/+$/, "").split("/").pop();
  const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
  const isMarkdown = (p) => /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i.test(p);
  const normalize = (p) => {
    const out = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return "/" + out.join("/");
  };
  const isDir = (p) => Object.keys(files).some((f) => f.startsWith(p.replace(/\/$/, "") + "/"));

  function request(path, extra) {
    return Object.assign(
      { path, kind: isDir(path) ? "folder" : files[path] !== undefined ? (isMarkdown(path) ? "markdown" : "text") : "missing", view: null, line: null, isStdin: false, insertAt: null, activate: true, readme: null, tab: null },
      extra || {},
    );
  }

  function emit(event, payload) {
    for (const id of listeners.get(event) || []) {
      const cb = callbacks.get(id);
      if (cb) cb({ event, id, payload });
    }
  }

  function readmeOf(dir) {
    const names = Object.keys(files).filter((f) => dirname(f) === dir);
    return names.find((f) => /\/readme\.md$/i.test(f)) || names.find((f) => /\/index\.md$/i.test(f)) || null;
  }

  function tree(root) {
    const node = { name: basename(root), path: root, isDir: true, children: [] };
    const dirs = new Map([[root, node]]);
    const ensure = (dir) => {
      if (dirs.has(dir)) return dirs.get(dir);
      const parent = ensure(dirname(dir));
      const n = { name: basename(dir), path: dir, isDir: true, children: [] };
      parent.children.push(n);
      dirs.set(dir, n);
      return n;
    };
    let count = 0;
    for (const f of Object.keys(files).sort()) {
      if (!f.startsWith(root + "/") || !isMarkdown(f)) continue;
      ensure(dirname(f)).children.push({ name: basename(f), path: f, isDir: false, children: [] });
      count++;
    }
    const sort = (n) => {
      n.children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      n.children.forEach(sort);
    };
    sort(node);
    return { root: node, fileCount: count, truncated: false };
  }

  const handlers = {
    take_window_init: () =>
      Object.assign({ tabs: [], activeTabId: null, folder: null, sidebar: null, notices: [], showDefaultAppBanner: false }, scenario.init),
    take_pending_opens: () => {
      const out = pending.map((p) => (typeof p === "string" ? request(p) : request(p.path, p)));
      pending = [];
      for (const r of out) {
        if (r.kind === "folder" && !r.readme) r.readme = readmeOf(r.path);
      }
      return out;
    },
    window_ready: () => {
      window.__mock.ready = true;
      return null;
    },
    registry_update: ({ snapshot }) => {
      registry = snapshot;
      return null;
    },
    read_document: ({ path, asText }) => {
      if (files[path] === undefined) {
        return { status: "error", path, name: basename(path), code: "notFound", message: "The file can’t be found. It may have been moved, renamed, or deleted." };
      }
      const text = files[path];
      return {
        status: "ready",
        path,
        name: basename(path),
        text,
        kind: asText || !isMarkdown(path) ? "text" : "markdown",
        encoding: "utf-8",
        hadBom: false,
        fallbackEncoding: false,
        lineEnding: "lf",
        size: text.length,
        modifiedMs: Date.now() - 42 * 60000,
        large: text.length > (scenario.largeBytes || 10 * 1024 * 1024),
      };
    },
    resolve_link: ({ from, href, root }) => {
      if (/^(https?:|mailto:)/i.test(href)) return { kind: "external", path: null, readme: null, fragment: null, url: href };
      if (/^[a-z][a-z0-9+.-]+:/i.test(href)) return { kind: "blocked", path: null, readme: null, fragment: null, url: null };
      const [raw, fragment] = href.split("#");
      const decoded = decodeURIComponent(raw.split("?")[0]);
      const path = normalize(decoded.startsWith("/") ? (root || "") + decoded : dirname(from) + "/" + decoded);
      if (files[path] !== undefined) return { kind: isMarkdown(path) ? "markdown" : "text", path, readme: null, fragment: fragment || null, url: null };
      if (isDir(path)) return { kind: "directory", path, readme: readmeOf(path), fragment: null, url: null };
      return { kind: "missing", path, readme: null, fragment: fragment || null, url: null };
    },
    allow_images: ({ doc, srcs }) => {
      const out = {};
      for (const src of srcs) {
        const path = normalize(src.startsWith("/") ? src : dirname(doc) + "/" + src);
        const ext = path.split(".").pop().toLowerCase();
        out[src] = window.__MOCK_IMAGES__ && window.__MOCK_IMAGES__.includes(path) ? { path, width: (IMAGES[ext] || [])[0] || null, height: (IMAGES[ext] || [])[1] || null } : null;
      }
      return out;
    },
    image_data_urls: () => ({}),
    list_folder: ({ root }) => tree(root),
    open_granted: ({ path, newWindow, view }) => {
      pending.push(request(path, { view }));
      setTimeout(() => emit("documents-opened", {}), 0);
      return null;
    },
    open_dropped: ({ paths, insertAt }) => {
      paths.forEach((p, i) => pending.push(request(p, { insertAt: insertAt == null ? null : insertAt + i })));
      setTimeout(() => emit("documents-opened", {}), 0);
      return null;
    },
    show_open_panel: () => null,
    locate_file: () => null,
    move_tab_to_new_window: () => "doc-2",
    merge_windows: () => null,
    list_open_documents: () => (registry ? registry.tabs.filter((t) => t.path).map((t) => ({ path: t.path, title: t.title, window: scenario.label })) : []),
    reveal_in_finder: () => null,
    open_external: () => null,
    open_in_editor: () => null,
    list_editors: () => [{ id: "com.microsoft.VSCode", name: "Visual Studio Code" }, { id: "com.apple.TextEdit", name: "TextEdit" }],
    show_logs_folder: () => null,
    popup_menu: ({ token, items }) => {
      window.__mock.lastMenu = { token, items };
      return null;
    },
    popup_path_menu: () => null,
    print_window: () => null,
    export_html: () => null,
    copy_to_clipboard: ({ text }) => {
      window.__mock.clipboard = text;
      return null;
    },
    get_settings: () => settings,
    update_settings: ({ patch }) => {
      Object.assign(settings, patch);
      setTimeout(() => emit("settings-changed", Object.assign({}, settings)), 0);
      return settings;
    },
    reset_settings: () => settings,
    get_recents: () => recents,
    clear_recents: () => {
      recents = [];
      return null;
    },
    get_reading_position: ({ path }) => positions[path] || null,
    save_reading_position: ({ position }) => {
      positions[position.path] = position;
      return null;
    },
    list_themes: () => [],
    open_themes_folder: () => null,
    default_app_status: () => ({ supported: true, isDefault: false, types: [{ uti: "net.daringfireball.markdown", extensions: ["md", "markdown"], handler: "Xcode", isDefault: false }] }),
    make_default_app: () => ({ supported: true, isDefault: true, types: [] }),
    dismiss_default_app_banner: () => null,
    install_cli: () => ({ ok: true, path: "/usr/local/bin/folio", message: "The folio command is installed." }),
    frontend_log: () => null,
    perf_mark: ({ name }) => {
      window.__mock.marks.push([name, performance.now()]);
      return null;
    },
    toolbar_double_click: () => null,
    start_window_drag: () => null,
    close_window: () => {
      window.__mock.closed = true;
      return null;
    },
    new_window: () => null,
    open_settings: () => null,
    "plugin:event|listen": ({ event, handler }) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return handler;
    },
    "plugin:event|unlisten": ({ event, eventId }) => {
      const list = listeners.get(event) || [];
      const i = list.indexOf(eventId);
      if (i >= 0) list.splice(i, 1);
      return null;
    },
    "plugin:window|set_title": () => null,
  };

  async function invoke(cmd, args) {
    calls.push([cmd, args]);
    if (!window.__firstIpc) window.__firstIpc = performance.now();
    if (cmd === "read_document" && !window.__readAt) window.__readAt = performance.now();
    const handler = handlers[cmd];
    if (!handler) {
      console.warn("[mock] unhandled command", cmd, args);
      return null;
    }
    return handler(args || {});
  }

  function transformCallback(callback, once) {
    const id = crypto.getRandomValues(new Uint32Array(1))[0];
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return callback && callback(data);
    });
    return id;
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback: (id, data) => callbacks.get(id) && callbacks.get(id)(data),
    callbacks,
    convertFileSrc: (path) => "/__fixtures__" + (path.startsWith(ROOT) ? path.slice(ROOT.length) : path),
    metadata: {
      currentWindow: { label: scenario.label },
      currentWebview: { windowLabel: scenario.label, label: scenario.label },
    },
    plugins: {},
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_e, id) => callbacks.delete(id) };

  window.__mock = {
    calls,
    files,
    marks: [],
    ready: false,
    emit,
    open(paths, extra) {
      for (const p of paths) pending.push(request(p, extra));
      emit("documents-opened", {});
    },
    change(path, text) {
      files[path] = text;
      emit("document-changed", { path, modifiedMs: Date.now() });
    },
    remove(path) {
      delete files[path];
      emit("document-removed", { path });
    },
    registry: () => registry,
  };
})();
