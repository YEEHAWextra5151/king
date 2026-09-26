/**
 * The window's workspace: tabs are app state, not webviews. Rust keeps an
 * authoritative copy (the registry) that this store reports to.
 */
import { create } from "zustand";
import type {
  FolderListing,
  HistoryEntry,
  OpenRequest,
  SidebarState,
  TabSnapshot,
  ViewMode,
  WindowSnapshot,
} from "../ipc/types";
import { basename } from "../lib/paths";
import type { Heading } from "../render/types";

export interface ScrollTarget {
  /** 0-based source line. */
  line?: number;
  fragment?: string;
  seq: number;
}

export interface Tab {
  id: string;
  path: string | null;
  kind: "markdown" | "text";
  title: string;
  isStdin: boolean;
  viewMode: ViewMode;
  splitRatio: number;
  /** Fractional source line at the top of the viewport. */
  anchor: number;
  history: { back: HistoryEntry[]; forward: HistoryEntry[] };
  scrollTarget: ScrollTarget | null;
  /** Large file: the user chose to render it anyway. */
  renderLarge: boolean;
}

export interface Banner {
  id: string;
  kind: "info" | "warning";
  text: string;
  detail?: string;
  actions?: { id: string; label: string; primary?: boolean }[];
  /** Only shown while this tab is active (null = window-wide). */
  tabId: string | null;
  dismissible: boolean;
}

export interface TabInfo {
  headings: Heading[];
  words: number;
  lines: number;
  currentLine: number;
}

interface WorkspaceState {
  tabs: Tab[];
  activeId: string | null;
  mru: string[];
  closed: Tab[];
  folder: string | null;
  folderListing: FolderListing | null;
  sidebar: SidebarState;
  findOpen: boolean;
  findSeq: number;
  quickOpen: boolean;
  banners: Banner[];
  fullscreen: boolean;
  zoomImage: string | null;
  info: Record<string, TabInfo>;
}

let seq = 0;
const nextSeq = () => ++seq;
export const newId = () => Math.random().toString(36).slice(2, 10);

export function makeTab(partial: Partial<Tab> & { path: string | null }): Tab {
  return {
    id: newId(),
    kind: "markdown",
    title: partial.path ? basename(partial.path) : "New Tab",
    isStdin: false,
    viewMode: "preview",
    splitRatio: 0.5,
    anchor: 0,
    history: { back: [], forward: [] },
    scrollTarget: null,
    renderLarge: false,
    ...partial,
  };
}

export function tabFromSnapshot(s: TabSnapshot): Tab {
  return makeTab({
    id: s.id || newId(),
    path: s.path,
    title: s.isStdin ? "Standard Input" : s.path ? basename(s.path) : "New Tab",
    kind: s.kind ?? "markdown",
    isStdin: s.isStdin,
    viewMode: s.kind === "text" ? "code" : s.viewMode,
    splitRatio: s.splitRatio ?? 0.5,
    anchor: s.anchor ?? 0,
    history: s.history ?? { back: [], forward: [] },
    scrollTarget: s.anchor ? { line: s.anchor, seq: nextSeq() } : null,
  });
}

export const useWorkspace = create<WorkspaceState>(() => ({
  tabs: [],
  activeId: null,
  mru: [],
  closed: [],
  folder: null,
  folderListing: null,
  sidebar: { visible: false, width: 240, pane: "outline" },
  findOpen: false,
  findSeq: 0,
  quickOpen: false,
  banners: [],
  fullscreen: false,
  zoomImage: null,
  info: {},
}));

const get = () => useWorkspace.getState();
const set = useWorkspace.setState;

export function activeTab(): Tab | null {
  const s = get();
  return s.tabs.find((t) => t.id === s.activeId) ?? null;
}

export function updateTab(id: string, update: Partial<Tab> | ((t: Tab) => Partial<Tab>)) {
  set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...(typeof update === "function" ? update(t) : update) } : t)),
  }));
}

export function activate(id: string) {
  set((s) => (s.tabs.some((t) => t.id === id) ? { activeId: id, mru: [id, ...s.mru.filter((m) => m !== id)] } : {}));
}

export interface OpenDefaults {
  defaultViewMode: ViewMode;
  /** Remembered per-file mode, when that setting is on. */
  rememberedMode?: (path: string) => ViewMode | null;
}

/** Applies open requests from Rust (Finder, CLI, drops, panel, recents). */
export function applyOpenRequests(requests: OpenRequest[], defaults: OpenDefaults) {
  for (const req of requests) {
    if (req.kind === "folder") {
      set((s) => ({
        folder: req.path,
        folderListing: s.folder === req.path ? s.folderListing : null,
        sidebar: { ...s.sidebar, visible: true, pane: "files" },
      }));
      if (req.readme) {
        openTab({ ...req, kind: "markdown", path: req.readme, readme: null }, defaults);
      }
      continue;
    }
    openTab(req, defaults);
  }
}

function openTab(req: OpenRequest, defaults: OpenDefaults) {
  const s = get();
  const existing = s.tabs.find((t) => t.path === req.path);
  const line = req.line != null ? Math.max(0, req.line - 1) : undefined;
  if (existing && !req.tab) {
    updateTab(existing.id, (t) => ({
      viewMode: req.view ?? t.viewMode,
      scrollTarget: line !== undefined ? { line, seq: nextSeq() } : t.scrollTarget,
    }));
    if (req.activate) activate(existing.id);
    return;
  }
  const kind: Tab["kind"] = req.kind === "text" ? "text" : "markdown";
  let tab: Tab;
  if (req.tab) {
    tab = tabFromSnapshot(req.tab);
  } else {
    const mode =
      kind === "text"
        ? "code"
        : req.view ?? defaults.rememberedMode?.(req.path) ?? defaults.defaultViewMode;
    tab = makeTab({
      path: req.path,
      kind,
      isStdin: req.isStdin,
      title: req.isStdin ? "Standard Input" : basename(req.path),
      viewMode: mode,
      scrollTarget: line !== undefined ? { line, seq: nextSeq() } : null,
    });
  }
  set((state) => {
    const tabs = [...state.tabs];
    // Opening into an empty New Tab replaces it (like Safari).
    const active = tabs.find((t) => t.id === state.activeId);
    if (active && active.path === null && req.insertAt == null) {
      const i = tabs.indexOf(active);
      tabs[i] = tab;
      return {
        tabs,
        activeId: req.activate || state.activeId === active.id ? tab.id : state.activeId,
        mru: [tab.id, ...state.mru.filter((m) => m !== active.id)],
      };
    }
    const at = req.insertAt != null ? Math.min(Math.max(req.insertAt, 0), tabs.length) : tabs.length;
    tabs.splice(at, 0, tab);
    return {
      tabs,
      activeId: req.activate || !state.activeId ? tab.id : state.activeId,
      mru: req.activate || !state.activeId ? [tab.id, ...state.mru] : [...state.mru, tab.id],
    };
  });
}

export function newTab(afterId?: string | null) {
  const tab = makeTab({ path: null });
  set((s) => {
    const tabs = [...s.tabs];
    const i = afterId ? tabs.findIndex((t) => t.id === afterId) : -1;
    tabs.splice(i >= 0 ? i + 1 : tabs.length, 0, tab);
    return { tabs, activeId: tab.id, mru: [tab.id, ...s.mru] };
  });
  return tab.id;
}

/** Closes tabs; returns true when the window has none left. */
export function closeTabs(ids: string[]): boolean {
  const s = get();
  const closing = s.tabs.filter((t) => ids.includes(t.id));
  if (closing.length === 0) return false;
  const remaining = s.tabs.filter((t) => !ids.includes(t.id));
  let activeId = s.activeId;
  if (activeId && ids.includes(activeId)) {
    const index = s.tabs.findIndex((t) => t.id === activeId);
    const after = s.tabs.slice(index + 1).find((t) => !ids.includes(t.id));
    const before = s.tabs
      .slice(0, index)
      .reverse()
      .find((t) => !ids.includes(t.id));
    activeId = (after ?? before)?.id ?? null;
  }
  const info = { ...s.info };
  ids.forEach((id) => delete info[id]);
  set({
    tabs: remaining,
    activeId,
    mru: [...(activeId ? [activeId] : []), ...s.mru.filter((m) => !ids.includes(m) && m !== activeId)],
    closed: [...s.closed, ...closing.filter((t) => t.path)].slice(-30),
    banners: s.banners.filter((b) => !b.tabId || !ids.includes(b.tabId)),
    info,
  });
  return remaining.length === 0;
}

export function reopenClosedTab() {
  const s = get();
  const tab = s.closed.at(-1);
  if (!tab) return;
  const restored = { ...tab, id: newId(), scrollTarget: { line: tab.anchor, seq: nextSeq() } };
  set({
    closed: s.closed.slice(0, -1),
    tabs: [...s.tabs.filter((t) => t.path !== null || s.tabs.length > 1), restored],
    activeId: restored.id,
    mru: [restored.id, ...s.mru],
  });
}

export function moveTab(id: string, toIndex: number) {
  set((s) => {
    const from = s.tabs.findIndex((t) => t.id === id);
    if (from < 0) return {};
    const tabs = [...s.tabs];
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.min(Math.max(toIndex, 0), tabs.length), 0, tab);
    return { tabs };
  });
}

export function cycleTab(delta: number) {
  const s = get();
  if (s.tabs.length < 2) return;
  const i = s.tabs.findIndex((t) => t.id === s.activeId);
  const next = s.tabs[(i + delta + s.tabs.length) % s.tabs.length];
  activate(next.id);
}

export function selectTabIndex(index: number) {
  const s = get();
  const tab = index < 0 ? s.tabs.at(-1) : s.tabs[index];
  if (tab) activate(tab.id);
}

export function setViewMode(id: string, mode: ViewMode) {
  updateTab(id, (t) => (t.kind === "text" && mode !== "code" ? {} : { viewMode: mode }));
}

/** Follows a link in the same tab, with back/forward history. */
export function navigate(id: string, target: { path: string; kind: "markdown" | "text"; fragment?: string; line?: number }) {
  updateTab(id, (t) => {
    const back = t.path ? [...t.history.back, { path: t.path, kind: t.kind, anchor: t.anchor }] : t.history.back;
    return {
      path: target.path,
      kind: target.kind,
      title: basename(target.path),
      isStdin: false,
      viewMode: target.kind === "text" ? "code" : t.kind === "text" ? "preview" : t.viewMode,
      anchor: 0,
      renderLarge: false,
      history: { back: back.slice(-100), forward: [] },
      scrollTarget: { fragment: target.fragment, line: target.line ?? (target.fragment ? undefined : 0), seq: nextSeq() },
    };
  });
}

/** In-document jump (anchor) that Back returns from. */
export function pushAnchor(id: string, fromLine: number) {
  updateTab(id, (t) => ({
    history: {
      back: t.path ? [...t.history.back, { path: t.path, kind: t.kind, anchor: fromLine }].slice(-100) : t.history.back,
      forward: [],
    },
  }));
}

export function goHistory(id: string, direction: -1 | 1) {
  updateTab(id, (t) => {
    const from = direction < 0 ? t.history.back : t.history.forward;
    const entry = from.at(-1);
    if (!entry || !t.path) return {};
    const current: HistoryEntry = { path: t.path, kind: t.kind, anchor: t.anchor };
    const history =
      direction < 0
        ? { back: t.history.back.slice(0, -1), forward: [...t.history.forward, current] }
        : { back: [...t.history.back, current], forward: t.history.forward.slice(0, -1) };
    return {
      path: entry.path,
      kind: entry.kind,
      title: basename(entry.path),
      viewMode: entry.kind === "text" ? "code" : t.kind === "text" ? "preview" : t.viewMode,
      anchor: entry.anchor,
      history,
      scrollTarget: { line: entry.anchor, seq: nextSeq() },
    };
  });
}

export function requestScroll(id: string, target: Omit<ScrollTarget, "seq">) {
  updateTab(id, { scrollTarget: { ...target, seq: nextSeq() } });
}

export function setTabInfo(id: string, info: Partial<TabInfo>) {
  set((s) => {
    const prev = s.info[id] ?? { headings: [], words: 0, lines: 0, currentLine: 0 };
    return { info: { ...s.info, [id]: { ...prev, ...info } } };
  });
}

export function addBanner(banner: Omit<Banner, "id"> & { id?: string }) {
  const id = banner.id ?? newId();
  set((s) => ({ banners: [...s.banners.filter((b) => b.id !== id), { ...banner, id }] }));
  return id;
}

export function removeBanner(id: string) {
  set((s) => ({ banners: s.banners.filter((b) => b.id !== id) }));
}

export function setSidebar(update: Partial<SidebarState>) {
  set((s) => ({ sidebar: { ...s.sidebar, ...update } }));
}

export function toSnapshot(t: Tab): TabSnapshot {
  return {
    id: t.id,
    path: t.path,
    title: t.title,
    isStdin: t.isStdin,
    viewMode: t.viewMode,
    kind: t.kind,
    anchor: Math.round(t.anchor * 100) / 100,
    splitRatio: t.splitRatio,
    history: t.history,
  };
}

export function windowSnapshot(): WindowSnapshot {
  const s = get();
  const active = s.tabs.find((t) => t.id === s.activeId) ?? null;
  const info = active ? s.info[active.id] : undefined;
  return {
    tabs: s.tabs.map(toSnapshot),
    activeTabId: s.activeId,
    folder: s.folder,
    sidebar: s.sidebar,
    menu: {
      hasDocument: !!active?.path,
      isMarkdown: active?.kind === "markdown",
      viewMode: active?.viewMode ?? "preview",
      canGoBack: (active?.history.back.length ?? 0) > 0,
      canGoForward: (active?.history.forward.length ?? 0) > 0,
      hasHeadings: (info?.headings.length ?? 0) > 0,
      hasClosedTabs: s.closed.length > 0,
      tabCount: s.tabs.length,
      sidebarVisible: s.sidebar.visible,
      sidebarPane: s.sidebar.pane,
      hasFolder: !!s.folder,
    },
  };
}
