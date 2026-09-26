/**
 * Commands, shared by the menu bar (menu-action events), keyboard
 * shortcuts, and context menus.
 */
import { ipc } from "../ipc";
import type { ViewMode } from "../ipc/types";
import { showContextMenu } from "../lib/contextMenu";
import { basename, dirname } from "../lib/paths";
import { loadDocument, getDoc } from "../store/docs";
import { getSettings } from "../store/settings";
import {
  activate,
  activeTab,
  addBanner,
  closeTabs,
  cycleTab,
  goHistory,
  navigate,
  newTab,
  pushAnchor,
  reopenClosedTab,
  requestScroll,
  setSidebar,
  setViewMode,
  toSnapshot,
  updateTab,
  useWorkspace,
  type Tab,
} from "../store/workspace";
import type { PreviewController } from "../views/preview";
import { panes } from "./panes";
import { findController } from "./findController";

function tabById(id?: string): Tab | null {
  const s = useWorkspace.getState();
  return (id ? s.tabs.find((t) => t.id === id) : activeTab()) ?? null;
}

function savePosition(tab: Tab) {
  if (tab.path && !tab.isStdin) {
    void ipc.saveReadingPosition({ path: tab.path, line: tab.anchor, viewMode: tab.viewMode });
  }
}

function close(ids: string[]) {
  const s = useWorkspace.getState();
  s.tabs.filter((t) => ids.includes(t.id)).forEach(savePosition);
  if (closeTabs(ids)) void ipc.closeWindow();
}

function focusInInput(): HTMLInputElement | HTMLTextAreaElement | null {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
}

export const actions = {
  newTab() {
    newTab(useWorkspace.getState().activeId);
  },
  openQuickly() {
    useWorkspace.setState({ quickOpen: true });
  },
  closeTab(id?: string) {
    const tab = tabById(id);
    if (tab) close([tab.id]);
    else void ipc.closeWindow();
  },
  closeOtherTabs(id: string) {
    close(useWorkspace.getState().tabs.filter((t) => t.id !== id).map((t) => t.id));
    activate(id);
  },
  closeTabsToRight(id: string) {
    const tabs = useWorkspace.getState().tabs;
    const i = tabs.findIndex((t) => t.id === id);
    close(tabs.slice(i + 1).map((t) => t.id));
  },
  reopenClosedTab() {
    reopenClosedTab();
  },
  copyPath(id?: string) {
    const tab = tabById(id);
    if (tab?.path) void ipc.copyToClipboard(tab.path);
  },
  openInEditor(id?: string) {
    const tab = tabById(id);
    if (!tab?.path || tab.isStdin) return;
    const line = panes.get(tab.id)?.editorLine();
    void ipc.openInEditor(tab.path, line).catch((err) =>
      addBanner({ kind: "warning", text: "Couldn’t open the editor.", detail: String(err), tabId: tab.id, dismissible: true }),
    );
  },
  revealInFinder(id?: string) {
    const tab = tabById(id);
    if (tab?.path && !tab.isStdin) void ipc.revealInFinder(tab.path);
  },
  async moveTabToNewWindow(id?: string) {
    const tab = tabById(id);
    if (!tab?.path || useWorkspace.getState().tabs.length < 2) return;
    try {
      await ipc.moveTabToNewWindow(toSnapshot(tab));
      closeTabs([tab.id]);
    } catch (err) {
      console.error(err);
    }
  },
  async locate(id?: string) {
    const tab = tabById(id);
    if (!tab?.path) return;
    const found = await ipc.locateFile(tab.path);
    if (!found) return;
    updateTab(tab.id, { path: found, title: basename(found) });
    void loadDocument(found, { reload: true, asText: tab.kind === "text" });
  },
  reload(id?: string) {
    const tab = tabById(id);
    if (tab?.path) void loadDocument(tab.path, { reload: true, asText: tab.kind === "text" });
  },
  print() {
    const tab = activeTab();
    if (!tab?.path) return;
    panes.get(tab.id)?.preparePrint();
    void ipc.printWindow();
  },
  async exportHtml() {
    const tab = activeTab();
    if (!tab?.path) return;
    const html = await buildExport(tab);
    if (!html) return;
    const name = basename(tab.path).replace(/\.[^.]+$/, "") + ".html";
    await ipc.exportHtml(html, name, tab.isStdin ? null : dirname(tab.path));
  },
  copyMarkdown() {
    const tab = activeTab();
    if (!tab?.path) return;
    const text = getDoc(tab.path)?.payload?.text ?? "";
    void ipc.copyToClipboard(selectedSource(text) ?? text);
  },
  copyHtml() {
    const tab = activeTab();
    if (!tab?.path) return;
    const selected = selectedHtml();
    const html = selected ?? cleanHtml(panes.get(tab.id)?.renderedHtml() ?? "");
    void ipc.copyToClipboard(html);
  },
  selectAll() {
    const input = focusInInput();
    if (input) {
      input.select();
      return;
    }
    const tab = activeTab();
    if (tab) panes.get(tab.id)?.selectAll();
  },
  find() {
    findController.open();
  },
  findNext() {
    findController.step(1);
  },
  findPrevious() {
    findController.step(-1);
  },
  findSelection() {
    const tab = activeTab();
    const text = (tab && panes.get(tab.id)?.selectedText()) || window.getSelection()?.toString() || "";
    if (text.trim()) findController.useSelection(text);
  },
  setView(mode: ViewMode) {
    const tab = activeTab();
    if (tab?.path) setViewMode(tab.id, mode);
  },
  toggleCode() {
    const tab = activeTab();
    if (!tab?.path || tab.kind === "text") return;
    setViewMode(tab.id, tab.viewMode === "code" ? "preview" : "code");
  },
  toggleSplit() {
    const tab = activeTab();
    if (!tab?.path || tab.kind === "text") return;
    setViewMode(tab.id, tab.viewMode === "split" ? "preview" : "split");
  },
  toggleSidebar() {
    const s = useWorkspace.getState().sidebar;
    setSidebar({ visible: !s.visible });
  },
  showSidebarPane(pane: "outline" | "files") {
    const s = useWorkspace.getState();
    if (pane === "files" && !s.folder) return;
    setSidebar({ visible: !(s.sidebar.visible && s.sidebar.pane === pane), pane });
  },
  goBack() {
    const tab = activeTab();
    if (tab) goHistory(tab.id, -1);
  },
  goForward() {
    const tab = activeTab();
    if (tab) goHistory(tab.id, 1);
  },
  nextHeading() {
    const tab = activeTab();
    if (tab) panes.get(tab.id)?.headingJump(1);
  },
  previousHeading() {
    const tab = activeTab();
    if (tab) panes.get(tab.id)?.headingJump(-1);
  },
  nextTab() {
    cycleTab(1);
  },
  previousTab() {
    cycleTab(-1);
  },
  focusTab(arg: { tabId: string; line?: number | null; view?: ViewMode | null }) {
    activate(arg.tabId);
    if (arg.view) setViewMode(arg.tabId, arg.view);
    if (arg.line != null) requestScroll(arg.tabId, { line: Math.max(0, arg.line - 1) });
  },
};

/** Dispatches a `menu-action` from Rust. */
export function runMenuAction(action: string, arg: unknown) {
  const map: Record<string, () => void> = {
    new_tab: actions.newTab,
    open_quickly: actions.openQuickly,
    close_tab: () => actions.closeTab(),
    reopen_closed_tab: actions.reopenClosedTab,
    reload: () => actions.reload(),
    open_in_editor: () => actions.openInEditor(),
    reveal_in_finder: () => actions.revealInFinder(),
    export_html: () => void actions.exportHtml(),
    print: actions.print,
    copy_markdown: actions.copyMarkdown,
    copy_html: actions.copyHtml,
    select_all: actions.selectAll,
    find: actions.find,
    find_next: actions.findNext,
    find_previous: actions.findPrevious,
    find_selection: actions.findSelection,
    toggle_code: actions.toggleCode,
    toggle_split: actions.toggleSplit,
    toggle_sidebar: actions.toggleSidebar,
    view_preview: () => actions.setView("preview"),
    view_code: () => actions.setView("code"),
    view_split: () => actions.setView("split"),
    sidebar_outline: () => actions.showSidebarPane("outline"),
    sidebar_files: () => actions.showSidebarPane("files"),
    go_back: actions.goBack,
    go_forward: actions.goForward,
    next_heading: actions.nextHeading,
    previous_heading: actions.previousHeading,
    previous_tab: actions.previousTab,
    next_tab: actions.nextTab,
    move_tab_to_new_window: () => void actions.moveTabToNewWindow(),
    "focus-tab": () => actions.focusTab(arg as { tabId: string; line?: number; view?: ViewMode }),
  };
  map[action]?.();
}

// ─── Links ──────────────────────────────────────────────────────────────

export async function followLink(tab: Tab, anchor: HTMLAnchorElement, event: MouseEvent, preview: PreviewController | null) {
  const href = anchor.getAttribute("href") ?? "";
  if (!tab.path) return;
  if (href.startsWith("#")) {
    const fragment = href.slice(1);
    if (!fragment) {
      preview?.scrollToTop();
      return;
    }
    pushAnchor(tab.id, tab.anchor);
    if (!preview?.scrollToFragment(fragment)) {
      addBanner({ kind: "info", text: `There’s no “#${fragment}” heading in this document.`, tabId: tab.id, dismissible: true, id: "missing-anchor" });
    }
    return;
  }
  const target = await ipc.resolveLink(tab.path, href, useWorkspace.getState().folder);
  const newTabRequested = event.metaKey || event.button === 1;
  switch (target.kind) {
    case "external":
      if (target.url) void ipc.openExternal(target.url);
      return;
    case "markdown":
    case "text":
    case "directory": {
      const path = target.kind === "directory" ? target.readme : target.path;
      if (!path) {
        if (target.path) void ipc.revealInFinder(target.path);
        return;
      }
      const kind = target.kind === "text" ? "text" : "markdown";
      if (newTabRequested) {
        void ipc.openGranted(path);
        return;
      }
      if (path === tab.path) {
        if (target.fragment) {
          pushAnchor(tab.id, tab.anchor);
          preview?.scrollToFragment(target.fragment);
        }
        return;
      }
      navigate(tab.id, { path, kind, fragment: target.fragment ?? undefined });
      return;
    }
    case "other":
      if (target.path) void ipc.revealInFinder(target.path);
      return;
    case "missing":
      addBanner({
        kind: "warning",
        text: `“${basename(target.path ?? href)}” doesn’t exist.`,
        detail: target.path ?? undefined,
        tabId: tab.id,
        dismissible: true,
        id: "missing-link",
      });
      return;
    default:
      return;
  }
}

export function showLinkMenu(tab: Tab, link: HTMLAnchorElement, preview: PreviewController | null): boolean {
  const href = link.getAttribute("href") ?? "";
  const external = /^(https?:|mailto:)/i.test(href);
  const fakeEvent = (meta: boolean) => ({ metaKey: meta, button: 0 }) as MouseEvent;
  showContextMenu([
    { label: "Open Link", action: () => void followLink(tab, link, fakeEvent(false), preview) },
    ...(!external && !href.startsWith("#")
      ? [{ label: "Open Link in New Tab", action: () => void followLink(tab, link, fakeEvent(true), preview) }]
      : []),
    { separator: true as const },
    { label: external && href.startsWith("mailto:") ? "Copy Email Address" : "Copy Link", action: () => void ipc.copyToClipboard(href.replace(/^mailto:/i, "")) },
  ]);
  return true;
}

export function showImageMenu(tab: Tab, image: HTMLImageElement): boolean {
  const src = image.getAttribute("src") ?? "";
  const remote = /^https?:/i.test(src);
  showContextMenu([
    { label: "Open Image", enabled: !!src, action: () => useWorkspace.setState({ zoomImage: image.currentSrc || image.src }) },
    { separator: true },
    {
      label: remote ? "Copy Image Address" : "Copy Image Path",
      enabled: !!src,
      action: () => void ipc.copyToClipboard(remote ? src : decodeAssetPath(src)),
    },
    {
      label: "Reveal in Finder",
      enabled: !remote && !!src && !!tab.path,
      action: () => void ipc.revealInFinder(decodeAssetPath(src)),
    },
  ]);
  return true;
}

function decodeAssetPath(src: string): string {
  const m = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/(.*)$/.exec(src);
  return m ? decodeURIComponent(m[1]) : src;
}

// ─── Copy helpers ───────────────────────────────────────────────────────

/** Source lines covered by the preview selection (Copy as Markdown). */
function selectedSource(text: string): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const block = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-source-line]") ?? null;
  const start = block(range.startContainer);
  const end = block(range.endContainer);
  if (!start || !end || !start.closest(".markdown-body")) return null;
  const from = Number(start.dataset.sourceLine);
  const to = Number(end.dataset.sourceLineEnd ?? end.dataset.sourceLine);
  const lines = text.split("\n");
  return lines.slice(from, Math.max(to, from + 1)).join("\n");
}

function selectedHtml(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!(range.commonAncestorContainer instanceof Node)) return null;
  const inDoc = (range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement
  )?.closest(".markdown-body");
  if (!inDoc) return null;
  const div = document.createElement("div");
  div.appendChild(range.cloneContents());
  return cleanHtml(div.innerHTML);
}

/** Removes Folio's internal attributes and UI from exported HTML. */
function cleanHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  root.querySelectorAll(".code-header, .mermaid-source, .sr-only").forEach((el) => el.remove());
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-source-line") || attr.name === "data-hl" || attr.name === "data-mermaid" || attr.name === "data-rendered" || attr.name === "tabindex") {
        el.removeAttribute(attr.name);
      }
    }
    el.classList.remove("block-changed");
  });
  const div = document.createElement("div");
  div.appendChild(root.cloneNode(true));
  return div.innerHTML;
}

// ─── Export ▸ HTML ──────────────────────────────────────────────────────

async function buildExport(tab: Tab): Promise<string | null> {
  const pane = panes.get(tab.id);
  const rendered = pane?.renderedHtml();
  if (!rendered) {
    addBanner({ kind: "info", text: "Switch to Preview to export this document as HTML.", tabId: tab.id, dismissible: true });
    return null;
  }
  const template = document.createElement("template");
  template.innerHTML = cleanHtml(rendered);
  const content = template.content;

  // Inline local images.
  const images = Array.from(content.querySelectorAll("img[src]")) as HTMLImageElement[];
  const local = images
    .map((img) => img.getAttribute("src") ?? "")
    .filter((src) => /^(asset:|https?:\/\/asset\.localhost)/i.test(src));
  if (local.length) {
    const paths = [...new Set(local.map(decodeAssetPath))];
    const data = await ipc.imageDataUrls(paths);
    for (const img of images) {
      const src = img.getAttribute("src") ?? "";
      const path = decodeAssetPath(src);
      if (data[path]) img.setAttribute("src", data[path]);
    }
  }
  content.querySelectorAll("source[srcset]").forEach((s) => {
    if (/(asset:|asset\.localhost)/.test(s.getAttribute("srcset") ?? "")) s.remove();
  });

  const css = await exportCss(!!content.querySelector(".katex"));
  const settings = getSettings();
  const root = document.documentElement;
  const div = document.createElement("div");
  div.appendChild(content.cloneNode(true));
  const title = tab.title.replace(/[<>&"]/g, "");
  return `<!doctype html>
<html lang="en" data-theme="${root.dataset.theme ?? "claude"}" data-font="${settings.fontFamily}" data-width="${settings.readingWidth}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Folio">
<title>${title}</title>
<style>
${css}
html, body { margin: 0; background: var(--surface); }
</style>
</head>
<body>
<article class="markdown-body">
${div.innerHTML}
</article>
</body>
</html>
`;
}

async function exportCss(withMath: boolean): Promise<string> {
  const keep = /(^:root|markdown-body|prefers-color-scheme|prefers-contrast|shiki|katex|@font-face|folio-changed|::highlight|sr-only)/;
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const text = rule.cssText;
      if (!withMath && /katex/i.test(text)) continue;
      if (keep.test(text)) parts.push(text);
    }
  }
  let css = parts.join("\n");
  if (withMath) {
    // Inline KaTeX fonts so the file is self-contained.
    const urls = [...new Set([...css.matchAll(/url\(["']?([^"')]+\.woff2)["']?\)/g)].map((m) => m[1]))];
    for (const url of urls) {
      try {
        const res = await fetch(new URL(url, location.href));
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        css = css.split(url).join(`data:font/woff2;base64,${btoa(bin)}`);
      } catch {
        /* keep the URL */
      }
    }
  }
  return css;
}
