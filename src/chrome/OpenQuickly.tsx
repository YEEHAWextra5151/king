import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../ipc";
import type { FolderNode, RecentItem } from "../ipc/types";
import { fuzzyPath } from "../lib/fuzzy";
import { basename, dirname, tildify } from "../lib/paths";
import { useWorkspace } from "../store/workspace";
import { FolderIcon, MarkdownDocIcon, SearchIcon } from "./icons";

interface Candidate {
  path: string;
  name: string;
  source: "tab" | "folder" | "recent";
  isFolder: boolean;
}

interface Result extends Candidate {
  score: number;
  indices: number[];
}

function flatten(node: FolderNode, out: Candidate[] = []): Candidate[] {
  for (const child of node.children) {
    if (child.isDir) flatten(child, out);
    else out.push({ path: child.path, name: child.name, source: "folder", isFolder: false });
  }
  return out;
}

const SOURCE_RANK = { tab: 3, folder: 2, recent: 1 } as const;
const MAX_RESULTS = 60;

/** Xcode-style Open Quickly over folder files, open tabs and recents. */
export function OpenQuickly() {
  const open = useWorkspace((s) => s.quickOpen);
  if (!open) return null;
  return <OpenQuicklyPanel />;
}

function OpenQuicklyPanel() {
  const listing = useWorkspace((s) => s.folderListing);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [tabs, setTabs] = useState<Candidate[]>([]);
  const [recents, setRecents] = useState<Candidate[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    void ipc.listOpenDocuments().then((docs) =>
      setTabs(docs.map((d) => ({ path: d.path, name: basename(d.path), source: "tab" as const, isFolder: false }))),
    );
    void ipc.getRecents().then((items: RecentItem[]) =>
      setRecents(items.map((r) => ({ path: r.path, name: r.name, source: "recent" as const, isFolder: r.isFolder }))),
    );
  }, []);

  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const c of [...tabs, ...(listing ? flatten(listing.root) : []), ...recents]) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push(c);
    }
    return out;
  }, [tabs, listing, recents]);

  const results: Result[] = useMemo(() => {
    if (!query.trim()) {
      return candidates.slice(0, MAX_RESULTS).map((c) => ({ ...c, score: 0, indices: [] }));
    }
    const out: Result[] = [];
    for (const c of candidates) {
      const m = fuzzyPath(query.trim(), c.name, c.path);
      if (m) out.push({ ...c, score: m.score + SOURCE_RANK[c.source] * 0.5, indices: m.indices });
    }
    out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return out.slice(0, MAX_RESULTS);
  }, [query, candidates]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const close = () => useWorkspace.setState({ quickOpen: false });
  const choose = (r: Result | undefined) => {
    if (!r) return;
    close();
    void ipc.openGranted(r.path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="quick-open" role="dialog" aria-label="Open Quickly" onKeyDown={onKeyDown}>
        <div className="quick-open-input">
          <SearchIcon size={18} />
          <input
            ref={input}
            value={query}
            placeholder="Open Quickly"
            aria-label="Open Quickly"
            aria-controls="quick-open-results"
            aria-activedescendant={results[selected] ? `qo-${selected}` : undefined}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="quick-open-results" id="quick-open-results" role="listbox" ref={list}>
          {results.length === 0 ? (
            <div className="quick-open-empty">{candidates.length ? "No matches" : "Open a folder to search its files."}</div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.path}
                id={`qo-${i}`}
                role="option"
                aria-selected={i === selected}
                className={`quick-open-row${i === selected ? " is-selected" : ""}`}
                onMouseMove={() => setSelected(i)}
                onClick={() => choose(r)}
              >
                <span className="row-icon">{r.isFolder ? <FolderIcon /> : <MarkdownDocIcon />}</span>
                <span className="text">
                  <span className="name">{highlight(r.name, r.indices)}</span>
                  <span className="detail">
                    {r.source === "tab" ? "Open · " : r.source === "recent" ? "Recent · " : ""}
                    {tildify(dirname(r.path))}
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function highlight(name: string, indices: number[]) {
  if (!indices.length) return name;
  const set = new Set(indices);
  return Array.from(name).map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : <span key={i}>{ch}</span>));
}
