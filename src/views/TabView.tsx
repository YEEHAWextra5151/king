import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { actions, followLink, showLinkMenu, showImageMenu } from "../app/actions";
import { panes, type PaneHandle } from "../app/panes";
import { hasFirstPainted, onFirstPaint, signalFirstPaint } from "../app/firstPaint";
import { perfEnd } from "../app/perfLog";
import { ipc } from "../ipc";
import type { ViewMode } from "../ipc/types";
import { CloudIcon, MissingDocIcon, WarningIcon } from "../chrome/icons";
import { Welcome } from "../chrome/Welcome";
import { loadDocument, useDocs, type DocEntry } from "../store/docs";
import { useSettings } from "../store/settings";
import {
  requestScroll,
  setTabInfo,
  setViewMode,
  updateTab,
  useWorkspace,
  type Tab,
} from "../store/workspace";
import type { CodeViewController } from "./codeview";
import { PreviewController, type CachedPreview } from "./preview";

/** Rendered HTML of tabs outside the mounted set (rebuilt on return). */
const previewCache = new Map<string, CachedPreview>();
const MAX_CACHED = 30;

export function TabView({ tab, active }: { tab: Tab; active: boolean }) {
  return (
    <div className={`tab-view${active ? " is-active" : ""}`} hidden={!active} aria-hidden={!active}>
      {tab.path ? <DocumentTab key={tab.path} tab={tab} active={active} /> : <Welcome active={active} />}
    </div>
  );
}

function effectiveMode(tab: Tab, entry: DocEntry | undefined): ViewMode {
  if (tab.kind === "text") return "code";
  if (entry?.payload?.large && !tab.renderLarge) return "code";
  return tab.viewMode;
}

function DocumentTab({ tab, active }: { tab: Tab; active: boolean }) {
  const path = tab.path!;
  const entry = useDocs((s) => s.entries[path]);
  const frontMatter = useSettings((s) => s.settings.frontMatter);
  const remoteImages = useSettings((s) => s.settings.remoteImages);
  const highlightChanges = useSettings((s) => s.settings.highlightChanges);
  const softWrap = useSettings((s) => s.settings.softWrap);
  const folder = useWorkspace((s) => s.folder);

  const previewHost = useRef<HTMLDivElement>(null);
  const codeHost = useRef<HTMLDivElement>(null);
  const printHost = useRef<HTMLPreElement>(null);
  const preview = useRef<PreviewController | null>(null);
  const code = useRef<CodeViewController | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const activeRef = useRef(active);
  activeRef.current = active;
  const entryRef = useRef(entry);
  entryRef.current = entry;

  const [renderError, setRenderError] = useState<Error | null>(null);
  // Background tabs render after the window's first paint, so the tab on
  // screen gets the worker first.
  const [mayRender, setMayRender] = useState(() => active || hasFirstPainted());
  useEffect(() => {
    if (mayRender) return;
    if (active) setMayRender(true);
    else onFirstPaint(() => setMayRender(true));
  }, [active, mayRender]);
  const [renderedVersion, setRenderedVersion] = useState(-1);
  const [codeReady, setCodeReady] = useState(false);
  const lastRender = useRef<string | null>(null);
  const consumedSeq = useRef(0);
  const anchorTimer = useRef(0);
  const positionTimer = useRef(0);
  const mode = effectiveMode(tab, entry);
  const needsPreview = mode !== "code" && !renderError;
  const needsCode = mode !== "preview" || !!renderError;

  // ─── Load ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!entry) void loadDocument(path, { asText: tab.kind === "text" });
  }, [entry, path, tab.kind]);

  // Restore the last reading position for tabs opened without a target.
  useEffect(() => {
    const t = tabRef.current;
    if (t.scrollTarget || t.anchor > 0 || t.isStdin) return;
    let cancelled = false;
    void ipc.getReadingPosition(path).then((pos) => {
      if (cancelled || !pos) return;
      const current = tabRef.current;
      if (current.scrollTarget || current.anchor > 0) return;
      const settings = useSettings.getState().settings;
      if (settings.rememberModePerFile && pos.viewMode && current.kind === "markdown") {
        setViewMode(current.id, pos.viewMode);
      }
      if (pos.line > 0) requestScroll(current.id, { line: pos.line });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // ─── Scroll bookkeeping ────────────────────────────────────────────────
  const onScrollLine = useCallback((line: number, byUser: boolean, atEnd: boolean, from: "preview" | "code") => {
    const t = tabRef.current;
    window.clearTimeout(anchorTimer.current);
    anchorTimer.current = window.setTimeout(() => updateTab(t.id, { anchor: line }), 120);
    setTabInfo(t.id, byUser ? { currentLine: line, atEnd, pinnedHeading: null } : { currentLine: line, atEnd });
    if (byUser && effectiveMode(t, entryRef.current) === "split") {
      if (from === "preview") code.current?.scrollToLine(line);
      else preview.current?.scrollToLineSync(line);
    }
    window.clearTimeout(positionTimer.current);
    positionTimer.current = window.setTimeout(() => {
      if (!t.isStdin && t.path) void ipc.saveReadingPosition({ path: t.path, line, viewMode: t.viewMode });
    }, 1500);
  }, []);

  // ─── Preview ───────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!needsPreview || preview.current || !previewHost.current) return;
    preview.current = new PreviewController(previewHost.current, {
      onScrollLine: (line, byUser, atEnd) => onScrollLine(line, byUser, atEnd, "preview"),
      onRendered: (output, initial) => {
        const t = tabRef.current;
        setTabInfo(t.id, { headings: output.headings, words: output.stats.words, lines: output.stats.lines });
        setRenderedVersion(preview.current?.version ?? -1);
        if (initial && !(t.scrollTarget && t.scrollTarget.seq > consumedSeq.current) && t.anchor > 0) {
          preview.current?.scrollToLine(t.anchor, { stick: true });
        }
        if (initial) void ipc.perfMark(`render-committed ${output.timings.total.toFixed(1)}ms worker`);
        else perfEnd(`reload:${t.path}`, "reload-committed");
        // Only the tab on screen decides when the window can appear.
        if (activeRef.current) signalFirstPaint();
      },
      onError: (error) => {
        console.error(error);
        setRenderError(error);
        if (activeRef.current) signalFirstPaint();
      },
      onLink: (anchor, event) => void followLink(tabRef.current, anchor, event, preview.current),
      onImageClick: (src) => useWorkspace.setState({ zoomImage: src }),
      onDoubleClickLine: (line) => {
        const t = tabRef.current;
        if (effectiveMode(t, entryRef.current) === "split" && code.current) {
          code.current.scrollToLine(line, { select: true, flash: true });
          code.current.focus();
        } else {
          setViewMode(t.id, "code");
          requestScroll(t.id, { line });
        }
      },
      onContextMenu: ({ link, image }) => {
        if (link) return showLinkMenu(tabRef.current, link, preview.current);
        if (image) return showImageMenu(tabRef.current, image);
        return false;
      },
    });
  }, [needsPreview, onScrollLine]);

  useEffect(() => {
    const ctrl = preview.current;
    const payload = entry?.payload;
    if (!ctrl || !payload || !needsPreview || entry?.asText || !mayRender) return;
    const key = `${path}|${entry.version}|${frontMatter}|${remoteImages}`;
    if (lastRender.current === key) return;
    const previous = lastRender.current;
    lastRender.current = key;
    const cached = previewCache.get(tab.id);
    if (!previous && cached && cached.path === path && cached.version === entry.version) {
      ctrl.restore(cached);
      previewCache.delete(tab.id);
      setTabInfo(tab.id, {
        headings: cached.output.headings,
        words: cached.output.stats.words,
        lines: cached.output.stats.lines,
      });
      setRenderedVersion(cached.version);
      requestAnimationFrame(() => ctrl.scrollToLine(tabRef.current.anchor));
      if (activeRef.current) signalFirstPaint();
      return;
    }
    const isReload = !!previous && previous.startsWith(`${path}|`) && !previous.startsWith(`${path}|${entry.version}|`);
    void ctrl.render({
      path,
      text: payload.text,
      version: entry.version,
      options: { frontMatter },
      remoteImages,
      folderRoot: folder,
      tint: isReload && highlightChanges,
    });
  }, [entry, needsPreview, frontMatter, remoteImages, folder, highlightChanges, path, tab.id, mayRender]);

  // ─── Code ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const payload = entry?.payload;
    if (!needsCode || !payload) return;
    if (code.current) {
      code.current.setText(payload.text);
      return;
    }
    let cancelled = false;
    void import("./codeview").then(({ CodeViewController }) => {
      if (cancelled || code.current || !codeHost.current) return;
      code.current = new CodeViewController(codeHost.current, {
        text: payload.text,
        fileName: tabRef.current.title,
        isMarkdown: tabRef.current.kind === "markdown",
        softWrap: useSettings.getState().settings.softWrap,
        onScrollLine: (line, byUser, atEnd) => onScrollLine(line, byUser, atEnd, "code"),
      });
      code.current.scrollToLine(tabRef.current.anchor);
      setCodeReady(true);
      if (activeRef.current && (tabRef.current.kind === "text" || effectiveMode(tabRef.current, entryRef.current) === "code")) {
        signalFirstPaint();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsCode, entry, onScrollLine]);

  useEffect(() => {
    code.current?.setSoftWrap(softWrap);
  }, [softWrap, codeReady]);

  // Switching modes keeps the reading position.
  const previousMode = useRef(mode);
  useLayoutEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    const line = tabRef.current.anchor;
    requestAnimationFrame(() => {
      if (mode !== "preview" && code.current) {
        code.current.view.requestMeasure();
        code.current.scrollToLine(line);
      }
      if (mode !== "code") preview.current?.scrollToLineSync(line);
      if (active) focusPrimary();
    });
  });

  // ─── Scroll targets (links, --line, restores, double-click) ─────────────
  useEffect(() => {
    const target = tab.scrollTarget;
    if (!target || target.seq <= consumedSeq.current) return;
    const previewReady = mode === "code" || renderedVersion >= 0;
    const codeOk = mode === "preview" || codeReady;
    if (!previewReady || !codeOk) return;
    consumedSeq.current = target.seq;
    if (target.fragment && preview.current && mode !== "code") {
      if (!preview.current.scrollToFragment(target.fragment)) preview.current.scrollToTop();
      return;
    }
    if (target.line !== undefined) {
      if (mode !== "code") preview.current?.scrollToLine(target.line, { stick: true });
      if (mode !== "preview") code.current?.scrollToLine(target.line, { select: true, flash: target.line > 0 });
      updateTab(tab.id, { anchor: target.line });
    }
  }, [tab.scrollTarget, renderedVersion, codeReady, mode, tab.id]);

  // ─── Focus ─────────────────────────────────────────────────────────────
  const focusPrimary = useCallback(() => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el?.closest?.(".overlay")) return;
    if (effectiveMode(tabRef.current, entryRef.current) === "code") code.current?.focus();
    else preview.current?.focus();
  }, []);

  useEffect(() => {
    if (active) requestAnimationFrame(focusPrimary);
  }, [active, codeReady, renderedVersion, focusPrimary]);

  // ─── Pane handle for menu actions ──────────────────────────────────────
  useEffect(() => {
    const handle: PaneHandle = {
      focus: focusPrimary,
      topLine: () => tabRef.current.anchor,
      scrollToLine: (line, flash) => {
        const m = effectiveMode(tabRef.current, entryRef.current);
        if (m !== "code") preview.current?.scrollToLine(line);
        if (m !== "preview") code.current?.scrollToLine(line, { flash });
      },
      selectAll: () => {
        const m = effectiveMode(tabRef.current, entryRef.current);
        const codeFocused = code.current?.view.hasFocus;
        if (m === "code" || (m === "split" && codeFocused)) code.current?.selectAll();
        else preview.current?.selectAll();
      },
      finder: () => {
        const m = effectiveMode(tabRef.current, entryRef.current);
        return m === "code" ? code.current : preview.current?.finder ?? null;
      },
      renderedHtml: () => (preview.current?.output ? preview.current.article.innerHTML : null),
      headingJump: (direction) => {
        const info = useWorkspace.getState().info[tabRef.current.id];
        if (effectiveMode(tabRef.current, entryRef.current) === "code") {
          const current = code.current?.topLine() ?? 0;
          const headings = info?.headings ?? [];
          const target =
            direction > 0
              ? headings.find((h) => h.line > current + 0.5)
              : [...headings].reverse().find((h) => h.line < current - 0.05);
          if (target) code.current?.scrollToLine(target.line, { select: true });
        } else {
          preview.current?.headingJump(info?.headings ?? [], direction);
        }
      },
      editorLine: () => {
        const m = effectiveMode(tabRef.current, entryRef.current);
        if (m !== "preview" && code.current) return code.current.cursorLine();
        return Math.floor(tabRef.current.anchor) + 1;
      },
      preparePrint: () => {
        const m = effectiveMode(tabRef.current, entryRef.current);
        const pre = printHost.current;
        if (m === "code" && pre) {
          pre.textContent = entryRef.current?.payload?.text ?? "";
          return () => {
            pre.textContent = "";
          };
        }
        return () => {};
      },
      retheme: () => preview.current?.retheme(),
      selectedText: () => {
        const m = effectiveMode(tabRef.current, entryRef.current);
        if (m === "code" || code.current?.view.hasFocus) return code.current?.selectedText() ?? "";
        return window.getSelection()?.toString() ?? "";
      },
    };
    panes.set(tab.id, handle);
    return () => {
      if (panes.get(tab.id) === handle) panes.delete(tab.id);
    };
  }, [tab.id, focusPrimary]);

  // ─── Unmount: cache rendered HTML, dispose controllers ─────────────────
  useEffect(
    () => () => {
      window.clearTimeout(anchorTimer.current);
      const snapshot = preview.current?.snapshot();
      if (snapshot) {
        previewCache.set(tabRef.current.id, snapshot);
        while (previewCache.size > MAX_CACHED) previewCache.delete(previewCache.keys().next().value!);
      }
      preview.current?.dispose();
      code.current?.dispose();
      preview.current = null;
      code.current = null;
    },
    [],
  );

  // ─── Render ────────────────────────────────────────────────────────────
  if (entry?.status === "error" && !entry.payload) {
    return <ErrorState tab={tab} entry={entry} active={active} />;
  }
  if (entry?.status === "downloading" && !entry.payload) {
    if (active) signalFirstPaint();
    return (
      <div className="error-state" role="status">
        <CloudIcon size={40} />
        <h1>Downloading “{tab.title}”…</h1>
        <p>It will appear here as soon as iCloud has it.</p>
      </div>
    );
  }
  const split = mode === "split";
  return (
    <>
      <div className={split ? "split" : undefined} style={{ position: "absolute", inset: 0 }}>
        <div
          className="split-pane code-pane-host"
          style={{
            display: mode === "preview" && !renderError ? "none" : undefined,
            width: split ? `${tab.splitRatio * 100}%` : "100%",
            position: split ? "relative" : "absolute",
            inset: split ? undefined : 0,
          }}
        >
          <div ref={codeHost} className="code-pane" />
        </div>
        {split && <SplitDivider tab={tab} />}
        <div
          className="split-pane"
          style={{
            display: mode === "code" || renderError ? "none" : undefined,
            flex: split ? 1 : undefined,
            position: split ? "relative" : "absolute",
            inset: split ? undefined : 0,
          }}
          ref={previewHost}
        />
      </div>
      {renderError && (
        <div className="banners">
          <div className="banner" role="alert">
            <WarningIcon />
            <div className="banner-text">
              Folio couldn’t render this document, so it’s shown as source.
              <div className="secondary">{renderError.message.split("\n")[0]}</div>
            </div>
            <div className="banner-actions">
              <button className="push-button" onClick={() => setRenderError(null)}>
                Try Again
              </button>
            </div>
          </div>
        </div>
      )}
      <pre className="print-source" ref={printHost} />
    </>
  );
}

function SplitDivider({ tab }: { tab: Tab }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = e.currentTarget.parentElement!;
    const rect = container.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      updateTab(tab.id, { splitRatio: Math.round(ratio * 1000) / 1000 });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(tab.splitRatio * 100)}
      onPointerDown={onPointerDown}
      onDoubleClick={() => updateTab(tab.id, { splitRatio: 0.5 })}
    />
  );
}

function ErrorState({ tab, entry, active }: { tab: Tab; entry: DocEntry; active: boolean }) {
  // A document that can't be shown still lets the window appear.
  useEffect(() => {
    if (active) signalFirstPaint();
  }, [active]);
  const code = entry.error?.code ?? "other";
  const title =
    code === "notFound"
      ? `Folio can’t find “${tab.title}”`
      : code === "permissionDenied"
        ? `Folio can’t read “${tab.title}”`
        : code === "binary"
          ? `“${tab.title}” doesn’t look like text`
          : code === "tooLarge"
            ? `“${tab.title}” is too large to open`
            : `Folio couldn’t open “${tab.title}”`;
  const retry = () => void loadDocument(tab.path!, { reload: true, asText: tab.kind === "text" });
  return (
    <div className="error-state" role="alert">
      {code === "notFound" ? <MissingDocIcon size={44} /> : <WarningIcon size={44} />}
      <h1>{title}</h1>
      <p>{entry.error?.message}</p>
      <div className="actions">
        {code === "notFound" && (
          <button className="push-button" onClick={() => void actions.locate(tab.id)}>
            Locate…
          </button>
        )}
        {code !== "notFound" && code !== "notAllowed" && (
          <button className="push-button" onClick={() => void ipc.revealInFinder(tab.path!)}>
            Show in Finder
          </button>
        )}
        <button className="push-button" onClick={retry}>
          Try Again
        </button>
        <button className="push-button" onClick={() => actions.closeTab(tab.id)}>
          Close Tab
        </button>
      </div>
    </div>
  );
}
