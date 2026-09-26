import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Banners, useTransientBanners } from "../chrome/Banners";
import { FindBar } from "../chrome/FindBar";
import { ImageZoom } from "../chrome/ImageZoom";
import { OpenQuickly } from "../chrome/OpenQuickly";
import { Sidebar } from "../chrome/Sidebar";
import { StatusBar } from "../chrome/StatusBar";
import { Toolbar } from "../chrome/Toolbar";
import { ipc, on } from "../ipc";
import type { OpenRequest } from "../ipc/types";
import { loadDocument, markRemoved, pruneDocs, useDocs } from "../store/docs";
import { getSettings, useSettings } from "../store/settings";
import {
  addBanner,
  applyOpenRequests,
  cycleTab,
  makeTab,
  selectTabIndex,
  tabFromSnapshot,
  useWorkspace,
  windowSnapshot,
} from "../store/workspace";
import { TabView } from "../views/TabView";
import { runMenuAction } from "./actions";
import { findController, useFind } from "./findController";
import { layoutMs, onFirstPaint, reportReady } from "./firstPaint";
import { panes } from "./panes";

const MOUNTED_TABS = 5;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function openDefaults() {
  return { defaultViewMode: getSettings().defaultViewMode };
}

function drainPending(requests: OpenRequest[]) {
  if (requests.length) applyOpenRequests(requests, openDefaults());
}

async function initWindow() {
  const [init, pending] = await Promise.all([ipc.takeWindowInit(), ipc.takePendingOpens()]);
  const tabs = init.tabs.map(tabFromSnapshot);
  useWorkspace.setState((s) => ({
    tabs,
    activeId: init.activeTabId && tabs.some((t) => t.id === init.activeTabId) ? init.activeTabId : (tabs[0]?.id ?? null),
    mru: tabs.map((t) => t.id),
    folder: init.folder,
    sidebar: init.sidebar ?? s.sidebar,
  }));
  if (init.activeTabId) {
    useWorkspace.setState((s) => ({ mru: [init.activeTabId!, ...s.mru.filter((m) => m !== init.activeTabId)] }));
  }
  drainPending(pending);
  if (useWorkspace.getState().tabs.length === 0) {
    const welcome = makeTab({ path: null });
    useWorkspace.setState({ tabs: [welcome], activeId: welcome.id, mru: [welcome.id] });
  }
  for (const notice of init.notices) addBanner({ kind: "info", text: notice, tabId: null, dismissible: true });
  if (init.showDefaultAppBanner) {
    addBanner({
      id: "default-app",
      kind: "info",
      text: "Make Folio your default app for Markdown files?",
      actions: [
        { id: "not-now", label: "Not Now" },
        { id: "make-default", label: "Make Default", primary: true },
      ],
      tabId: null,
      dismissible: false,
    });
  }
  // Preload the document of the active tab right away (in parallel with React).
  const active = useWorkspace.getState().tabs.find((t) => t.id === useWorkspace.getState().activeId);
  if (active?.path) void loadDocument(active.path, { asText: active.kind === "text" });
}

export function DocumentWindow() {
  const [ready, setReady] = useState(false);
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const mru = useWorkspace((s) => s.mru);
  const fullscreen = useWorkspace((s) => s.fullscreen);
  const [dropTarget, setDropTarget] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  useTransientBanners();

  // ─── Init + events ─────────────────────────────────────────────────────
  useEffect(() => {
    const unlisten: Promise<() => void>[] = [];
    unlisten.push(on("documents-opened", () => void ipc.takePendingOpens().then(drainPending)));
    unlisten.push(
      on("document-changed", ({ path }) => {
        if (useDocs.getState().entries[path]) void loadDocument(path, { reload: true });
      }),
    );
    unlisten.push(on("document-removed", ({ path }) => markRemoved(path)));
    unlisten.push(on("menu-action", ({ action, arg }) => runMenuAction(action, arg)));
    unlisten.push(
      on("settings-changed", (settings) => {
        const previous = getSettings();
        useSettings.getState().setSettings(settings);
        if (previous.theme !== settings.theme || previous.appearance !== settings.appearance) {
          requestAnimationFrame(() => panes.forEach((p) => p.retheme()));
        }
      }),
    );
    unlisten.push(on("themes-changed", (themes) => useSettings.getState().setCustomThemes(themes)));
    unlisten.push(on("window-state", ({ fullscreen }) => useWorkspace.setState({ fullscreen })));

    void ipc.listThemes().then((themes) => useSettings.getState().setCustomThemes(themes));
    void initWindow().then(() => setReady(true));

    const media = matchMedia("(prefers-color-scheme: dark)");
    const onAppearance = () => panes.forEach((p) => p.retheme());
    media.addEventListener("change", onAppearance);

    return () => {
      unlisten.forEach((u) => void u.then((f) => f()));
      media.removeEventListener("change", onAppearance);
    };
  }, []);

  // Show the window once the first document (or Welcome) has painted.
  useEffect(() => {
    if (!ready) return;
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      reportReady(() => {
        void ipc.windowReady();
        if (layoutMs !== null) void ipc.perfMark(`first-layout ${layoutMs.toFixed(0)}ms`);
      });
    };
    onFirstPaint(show);
    const fallback = window.setTimeout(show, 900);
    return () => window.clearTimeout(fallback);
  }, [ready]);

  // ─── Registry sync (Rust keeps the authoritative copy) ─────────────────
  useEffect(() => {
    if (!ready) return;
    let timer = 0;
    let last = "";
    const send = () => {
      const snapshot = windowSnapshot();
      const json = JSON.stringify(snapshot);
      if (json === last) return;
      last = json;
      void ipc.registryUpdate(snapshot);
    };
    send();
    const unsubscribe = useWorkspace.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(send, 40);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [ready]);

  // Drop document cache entries no tab needs; refresh find on tab switch.
  useEffect(() => {
    pruneDocs(new Set(tabs.map((t) => t.path).filter((p): p is string => !!p)));
  }, [tabs]);
  useEffect(() => {
    if (useFind.getState().open) requestAnimationFrame(() => findController.refresh());
  }, [activeId]);

  // Save reading positions when the window goes away.
  useEffect(() => {
    const save = () => {
      for (const t of useWorkspace.getState().tabs) {
        if (t.path && !t.isStdin) void ipc.saveReadingPosition({ path: t.path, line: t.anchor, viewMode: t.viewMode });
      }
    };
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, []);

  // ─── Keyboard shortcuts not owned by the menu bar ──────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = Number(e.key);
        selectTabIndex(n === 9 ? -1 : n - 1);
        return;
      }
      // ⌘= zooms in too (the menu shows ⌘+).
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "=") {
        e.preventDefault();
        const current = getSettings().textZoom;
        const next = ZOOM_STEPS.find((z) => z > current + 1e-6) ?? ZOOM_STEPS.at(-1)!;
        void ipc.updateSettings({ textZoom: next });
        return;
      }
      if (e.key === "Escape" && useFind.getState().open && !(e.target instanceof HTMLInputElement)) {
        findController.close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ─── Drag and drop (files onto the window or the tab bar) ──────────────
  useEffect(() => {
    let indicator: HTMLDivElement | null = null;
    const insertionIndex = (x: number, y: number): number | null => {
      const bar = document.querySelector(".tabstrip");
      if (!bar) return null;
      const rect = bar.getBoundingClientRect();
      if (y > rect.bottom + 4) return null;
      const tabsEls = Array.from(bar.querySelectorAll<HTMLElement>(".tab"));
      let index = tabsEls.length;
      for (let i = 0; i < tabsEls.length; i++) {
        const r = tabsEls[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) {
          index = i;
          break;
        }
      }
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "tab-drop-indicator";
        document.querySelector(".tabbar")?.appendChild(indicator);
      }
      const barRect = document.querySelector(".tabbar")!.getBoundingClientRect();
      const edge =
        index < tabsEls.length ? tabsEls[index].getBoundingClientRect().left : (tabsEls.at(-1)?.getBoundingClientRect().right ?? rect.left);
      indicator.style.left = `${edge - barRect.left}px`;
      return index;
    };
    const clear = () => {
      indicator?.remove();
      indicator = null;
      setDropTarget(false);
    };
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "leave") {
        clear();
        return;
      }
      const scale = window.devicePixelRatio || 1;
      const x = p.position.x / scale;
      const y = p.position.y / scale;
      if (p.type === "over" || p.type === "enter") {
        const index = insertionIndex(x, y);
        if (index === null) {
          indicator?.remove();
          indicator = null;
          setDropTarget(true);
        } else {
          setDropTarget(false);
        }
        return;
      }
      if (p.type === "drop") {
        const index = insertionIndex(x, y);
        clear();
        if (p.paths.length) void ipc.openDropped(p.paths, index);
      }
    });
    return () => void unlisten.then((u) => u());
  }, []);

  // ─── Mounted tabs: the most recently used few stay alive ───────────────
  const mounted = useMemo(() => {
    const ids = new Set(mru.slice(0, MOUNTED_TABS));
    if (activeId) ids.add(activeId);
    return tabs.filter((t) => ids.has(t.id));
  }, [tabs, mru, activeId]);

  if (!ready) return <div className="app" />;
  return (
    <div className={`app${fullscreen ? " is-fullscreen" : ""}`}>
      <Toolbar />
      <FindBar />
      <div className="app-main">
        <Sidebar />
        <main ref={contentRef} className={`app-content${dropTarget ? " drop-target" : ""}`} aria-label="Document">
          {mounted.map((tab) => (
            <TabView key={tab.id} tab={tab} active={tab.id === activeId} />
          ))}
          <Banners />
        </main>
      </div>
      <StatusBar />
      <OpenQuickly />
      <ImageZoom />
    </div>
  );
}
