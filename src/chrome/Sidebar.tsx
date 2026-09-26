import { useEffect, useMemo, useRef, useState } from "react";
import { panes } from "../app/panes";
import { ipc } from "../ipc";
import type { FolderNode } from "../ipc/types";
import { showContextMenu } from "../lib/contextMenu";
import { setSidebar, setTabInfo, useWorkspace } from "../store/workspace";
import { DisclosureIcon, FolderIcon, MarkdownDocIcon } from "./icons";

export function Sidebar() {
  const { visible, width, pane } = useWorkspace((s) => s.sidebar);
  const folder = useWorkspace((s) => s.folder);
  if (!visible) return null;
  const current = folder ? pane : "outline";

  const onResize = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startWidth = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      setSidebar({ width: Math.round(Math.min(420, Math.max(180, startWidth + ev.clientX - startX))) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <nav className="sidebar" style={{ width }} aria-label="Sidebar">
      <div className="sidebar-header">
        <div className="segmented text-segments" role="tablist" aria-label="Sidebar view">
          <button type="button" role="tab" aria-checked={current === "outline"} aria-selected={current === "outline"} onClick={() => setSidebar({ pane: "outline" })}>
            Outline
          </button>
          <button
            type="button"
            role="tab"
            aria-checked={current === "files"}
            aria-selected={current === "files"}
            disabled={!folder}
            title={folder ? undefined : "Open a folder to browse its files"}
            onClick={() => setSidebar({ pane: "files" })}
          >
            Files
          </button>
        </div>
      </div>
      {current === "outline" ? <Outline /> : <Files root={folder!} />}
      <div className="sidebar-resizer" role="separator" aria-orientation="vertical" onPointerDown={onResize} />
    </nav>
  );
}

function Outline() {
  const activeId = useWorkspace((s) => s.activeId);
  const info = useWorkspace((s) => (s.activeId ? s.info[s.activeId] : undefined));
  const headings = info?.headings ?? [];
  const currentLine = info?.currentLine ?? 0;
  const body = useRef<HTMLDivElement>(null);
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);

  let currentIndex = info?.pinnedHeading != null ? headings.findIndex((h) => h.line === info.pinnedHeading) : -1;
  if (currentIndex < 0) {
    headings.forEach((h, i) => {
      if (h.line <= currentLine + 0.6) currentIndex = i;
    });
    // At the end of the document the last sections can't scroll to the top.
    if (info?.atEnd && headings.length) currentIndex = headings.length - 1;
  }
  const go = (line: number) => {
    if (!activeId) return;
    setTabInfo(activeId, { pinnedHeading: line });
    panes.get(activeId)?.scrollToLine(line);
  };

  useEffect(() => {
    body.current?.querySelector(".is-current")?.scrollIntoView({ block: "nearest" });
  }, [currentIndex]);

  if (!headings.length) {
    return <div className="sidebar-empty">{activeId ? "This document has no headings." : ""}</div>;
  }
  return (
    <div className="sidebar-body" ref={body} role="tree" aria-label="Outline">
      {headings.map((h, i) => (
        <div
          key={`${h.id}-${i}`}
          role="treeitem"
          aria-level={h.level - minLevel + 1}
          aria-current={i === currentIndex ? "location" : undefined}
          tabIndex={i === Math.max(currentIndex, 0) ? 0 : -1}
          className={`row outline-item level-${h.level - minLevel + 1}${i === currentIndex ? " is-current" : ""}`}
          style={{ paddingLeft: 8 + (h.level - minLevel) * 14 }}
          onClick={() => go(h.line)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              go(h.line);
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const next = (e.currentTarget.parentElement?.children[i + (e.key === "ArrowDown" ? 1 : -1)] as HTMLElement | undefined);
              next?.focus();
            }
          }}
        >
          <span className="row-label">{h.text || "Untitled"}</span>
        </div>
      ))}
    </div>
  );
}

function Files({ root }: { root: string }) {
  const listing = useWorkspace((s) => s.folderListing);
  const activePath = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeId)?.path ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      ipc
        .listFolder(root)
        .then((l) => alive && useWorkspace.setState({ folderListing: l }))
        .catch((e) => alive && setError(String(e)));
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [root]);

  // Reveal the active document in the tree.
  useEffect(() => {
    if (!activePath || !activePath.startsWith(root + "/")) return;
    const parts = activePath.slice(root.length + 1).split("/").slice(0, -1);
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = root;
      for (const p of parts) {
        acc = `${acc}/${p}`;
        next.add(acc);
      }
      return next;
    });
  }, [activePath, root]);

  const rows = useMemo(() => {
    const out: { node: FolderNode; depth: number }[] = [];
    const walk = (node: FolderNode, depth: number) => {
      for (const child of node.children) {
        out.push({ node: child, depth });
        if (child.isDir && expanded.has(child.path)) walk(child, depth + 1);
      }
    };
    if (listing) walk(listing.root, 0);
    return out;
  }, [listing, expanded]);

  if (error) return <div className="sidebar-empty">{error}</div>;
  if (!listing) return <div className="sidebar-empty" />;
  if (!rows.length) return <div className="sidebar-empty">No Markdown files in this folder.</div>;

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const menu = (node: FolderNode) =>
    showContextMenu([
      ...(node.isDir ? [] : [{ label: "Open", action: () => void ipc.openGranted(node.path) }]),
      ...(node.isDir ? [] : [{ label: "Open in New Window", action: () => void ipc.openGranted(node.path, { newWindow: true }) }]),
      { label: "Reveal in Finder", action: () => void ipc.revealInFinder(node.path) },
      { separator: true },
      { label: "Copy Path", action: () => void ipc.copyToClipboard(node.path) },
    ]);

  return (
    <div className="sidebar-body" role="tree" aria-label="Files">
      {rows.map(({ node, depth }, i) => {
        const selected = node.path === activePath;
        return (
          <div
            key={node.path}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={node.isDir ? expanded.has(node.path) : undefined}
            aria-selected={selected}
            tabIndex={selected || (i === 0 && !activePath) ? 0 : -1}
            className={`row${selected ? " is-selected" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            title={node.path}
            onClick={() => (node.isDir ? toggle(node.path) : void ipc.openGranted(node.path))}
            onContextMenu={(e) => {
              e.preventDefault();
              menu(node);
            }}
            onKeyDown={(e) => {
              const rowsEl = e.currentTarget.parentElement!;
              const move = (d: number) => (rowsEl.children[i + d] as HTMLElement | undefined)?.focus();
              if (e.key === "ArrowDown") (e.preventDefault(), move(1));
              else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
              else if (e.key === "ArrowRight" && node.isDir && !expanded.has(node.path)) toggle(node.path);
              else if (e.key === "ArrowLeft" && node.isDir && expanded.has(node.path)) toggle(node.path);
              else if (e.key === "Enter") {
                e.preventDefault();
                if (node.isDir) toggle(node.path);
                else void ipc.openGranted(node.path);
              }
            }}
          >
            {node.isDir ? (
              <DisclosureIcon className={`icon disclosure${expanded.has(node.path) ? " is-open" : ""}`} />
            ) : (
              <span className="disclosure-spacer" />
            )}
            <span className="row-icon">{node.isDir ? <FolderIcon /> : <MarkdownDocIcon />}</span>
            <span className="row-label">{node.name}</span>
          </div>
        );
      })}
      {listing.truncated && <div className="sidebar-empty">Showing the first {listing.fileCount.toLocaleString()} files.</div>}
    </div>
  );
}
