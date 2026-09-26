import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../ipc";
import { showContextMenu } from "../lib/contextMenu";
import { disambiguate } from "../lib/paths";
import { actions } from "../app/actions";
import {
  activate,
  moveTab,
  setSidebar,
  setViewMode,
  useWorkspace,
  type Tab,
} from "../store/workspace";
import { CloseIcon, ChevronDownIcon, CodeIcon, PreviewIcon, SidebarIcon, SplitIcon } from "./icons";

/** Empty toolbar space drags the window; double-click follows System Settings. */
function useWindowDrag() {
  const down = useRef<{ x: number; y: number } | null>(null);
  const isEmptySpace = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !!el?.closest("[data-drag-region]") && !el.closest("button, [role=tab], input, .segmented");
  };
  return {
    onMouseDown(e: React.MouseEvent) {
      if (e.button !== 0 || !isEmptySpace(e.target)) return;
      e.preventDefault();
      if (e.detail === 1) void ipc.startWindowDrag();
      down.current = { x: e.clientX, y: e.clientY };
    },
    onMouseUp(e: React.MouseEvent) {
      if (e.button !== 0 || e.detail !== 2 || !isEmptySpace(e.target)) return;
      const d = down.current;
      if (d && Math.abs(d.x - e.clientX) < 3 && Math.abs(d.y - e.clientY) < 3) void ipc.toolbarDoubleClick();
    },
  };
}

export function Toolbar() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const sidebarVisible = useWorkspace((s) => s.sidebar.visible);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const drag = useWindowDrag();

  return (
    <header className="toolbar" data-drag-region onMouseDown={drag.onMouseDown} onMouseUp={drag.onMouseUp}>
      <div className="toolbar-group" data-drag-region>
        <button
          type="button"
          className="toolbar-button"
          aria-label={sidebarVisible ? "Hide Sidebar" : "Show Sidebar"}
          aria-pressed={sidebarVisible}
          title={sidebarVisible ? "Hide Sidebar (⌃⌘S)" : "Show Sidebar (⌃⌘S)"}
          onClick={() => setSidebar({ visible: !sidebarVisible })}
        >
          <SidebarIcon />
        </button>
      </div>
      <TabBar tabs={tabs} activeId={activeId} />
      <div className="toolbar-group" data-drag-region>
        <ViewModeControl tab={active} />
      </div>
    </header>
  );
}

function ViewModeControl({ tab }: { tab: Tab | null }) {
  const disabled = !tab?.path;
  const textOnly = tab?.kind === "text";
  const modes = [
    { mode: "preview" as const, label: "Preview", icon: <PreviewIcon />, key: "⌘/" },
    { mode: "code" as const, label: "Code", icon: <CodeIcon />, key: "⌘/" },
    { mode: "split" as const, label: "Split", icon: <SplitIcon />, key: "⌘\\" },
  ];
  return (
    <div className="segmented" role="radiogroup" aria-label="View mode">
      {modes.map((m) => (
        <button
          key={m.mode}
          type="button"
          role="radio"
          aria-checked={!disabled && tab?.viewMode === m.mode}
          aria-label={m.label}
          title={`${m.label} (${m.key})`}
          disabled={disabled || (textOnly && m.mode !== "code")}
          onClick={() => tab && setViewMode(tab.id, m.mode)}
        >
          {m.icon}
        </button>
      ))}
    </div>
  );
}

function TabBar({ tabs, activeId }: { tabs: Tab[]; activeId: string | null }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const [overflowing, setOverflowing] = useState(false);
  const labels = useMemo(() => disambiguate(tabs.map((t) => (t.isStdin ? null : t.path))), [tabs]);

  // Overflow detection and keeping the active tab in view.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const check = () => setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [tabs.length]);

  useEffect(() => {
    if (!activeId) return;
    tabRefs.current.get(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, tab: Tab, index: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    if (e.metaKey) {
      e.preventDefault();
      if (tab.path && !tab.isStdin) void ipc.popupPathMenu(tab.path);
      return;
    }
    activate(tab.id);
    const el = e.currentTarget;
    const strip = stripRef.current!;
    const startX = e.clientX;
    const rects = tabs.map((t) => tabRefs.current.get(t.id)!.getBoundingClientRect());
    let dragging = false;
    let target = index;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < 4) return;
        dragging = true;
        el.setPointerCapture(ev.pointerId);
        strip.classList.add("is-reordering");
        el.classList.add("is-dragging");
      }
      const minDx = rects[0].left - rects[index].left;
      const maxDx = rects[rects.length - 1].right - rects[index].right;
      const clamped = Math.min(Math.max(dx, minDx), maxDx);
      el.style.transform = `translateX(${clamped}px)`;
      const center = rects[index].left + rects[index].width / 2 + clamped;
      target = index;
      rects.forEach((r, i) => {
        const mid = r.left + r.width / 2;
        if (i < index && center < mid) target = Math.min(target, i);
        if (i > index && center > mid) target = Math.max(target, i);
      });
      const w = rects[index].width;
      tabs.forEach((t, i) => {
        if (i === index) return;
        let shift = 0;
        if (index < target && i > index && i <= target) shift = -w;
        if (index > target && i < index && i >= target) shift = w;
        const other = tabRefs.current.get(t.id);
        if (other) other.style.transform = shift ? `translateX(${shift}px)` : "";
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!dragging) return;
      strip.classList.remove("is-reordering");
      el.classList.remove("is-dragging");
      tabRefs.current.forEach((node) => (node.style.transform = ""));
      if (target !== index) moveTab(tab.id, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const onContextMenu = (e: React.MouseEvent, tab: Tab, index: number) => {
    e.preventDefault();
    const hasFile = !!tab.path && !tab.isStdin;
    showContextMenu([
      { label: "Close Tab", action: () => actions.closeTab(tab.id) },
      { label: "Close Other Tabs", enabled: tabs.length > 1, action: () => actions.closeOtherTabs(tab.id) },
      {
        label: "Close Tabs to the Right",
        enabled: index < tabs.length - 1,
        action: () => actions.closeTabsToRight(tab.id),
      },
      { separator: true },
      { label: "Copy Path", enabled: hasFile, action: () => actions.copyPath(tab.id) },
      { label: "Reveal in Finder", enabled: hasFile, action: () => tab.path && void ipc.revealInFinder(tab.path) },
      { label: "Open in Editor", enabled: hasFile, action: () => actions.openInEditor(tab.id) },
      { separator: true },
      {
        label: "Move to New Window",
        enabled: !!tab.path && tabs.length > 1,
        action: () => actions.moveTabToNewWindow(tab.id),
      },
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    activate(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const overflowMenu = () =>
    showContextMenu(
      tabs.map((t, i) => ({
        label: labels[i] ? `${t.title} — ${labels[i]}` : t.title,
        checked: t.id === activeId,
        action: () => activate(t.id),
      })),
    );

  return (
    <div className="tabbar" data-drag-region>
      <div className="tabstrip" ref={stripRef} role="tablist" aria-label="Documents" data-drag-region>
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId;
          const label = labels[index];
          return (
            <div
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              className={`tab${isActive ? " is-active" : ""}`}
              role="tab"
              aria-selected={isActive}
              aria-label={label ? `${tab.title}, ${label}` : tab.title}
              tabIndex={isActive ? 0 : -1}
              title={tab.isStdin ? "Standard Input" : tab.path ?? "New Tab"}
              data-tab-id={tab.id}
              onPointerDown={(e) => onPointerDown(e, tab, index)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  actions.closeTab(tab.id);
                }
              }}
              onContextMenu={(e) => onContextMenu(e, tab, index)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.title}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.closeTab(tab.id);
                }}
              >
                <CloseIcon />
              </button>
              <span className="tab-title">
                {tab.title}
                {label && <span className="tab-disambiguation"> — {label}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {overflowing && (
        <button type="button" className="toolbar-button tab-overflow" aria-label="All Tabs" title="All Tabs" onClick={overflowMenu}>
          <ChevronDownIcon />
        </button>
      )}
    </div>
  );
}
