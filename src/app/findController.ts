/**
 * Find (⌘F, ⌘G / ⇧⌘G, ⌘E, Esc) for the active tab. The bar is per window;
 * it searches whichever pane is visible (Preview or Code).
 */
import { create } from "zustand";
import { activeTab } from "../store/workspace";
import { panes } from "./panes";

interface FindState {
  open: boolean;
  query: string;
  total: number;
  current: number;
  /** Bumped to (re)focus the field. */
  focusSeq: number;
}

export const useFind = create<FindState>(() => ({ open: false, query: "", total: 0, current: -1, focusSeq: 0 }));

function target() {
  const tab = activeTab();
  return tab ? (panes.get(tab.id)?.finder() ?? null) : null;
}

let lastTarget: ReturnType<typeof target> = null;

function run(query: string, fromTop = false) {
  const t = target();
  if (lastTarget && lastTarget !== t) lastTarget.clear();
  lastTarget = t;
  const result = t ? t.search(query, fromTop) : { total: 0, current: -1 };
  useFind.setState({ total: result.total, current: result.current });
}

export const findController = {
  open() {
    const s = useFind.getState();
    useFind.setState({ open: true, focusSeq: s.focusSeq + 1 });
    if (s.query) run(s.query);
  },
  close() {
    lastTarget?.clear();
    lastTarget = null;
    useFind.setState({ open: false, total: 0, current: -1 });
    const tab = activeTab();
    if (tab) panes.get(tab.id)?.focus();
  },
  setQuery(query: string) {
    useFind.setState({ query });
    run(query);
  },
  step(direction: 1 | -1) {
    const s = useFind.getState();
    if (!s.open) {
      useFind.setState({ open: true });
      if (s.query) run(s.query);
      return;
    }
    const t = target();
    if (!t || !s.query) return;
    if (t !== lastTarget) {
      run(s.query);
      return;
    }
    const result = direction > 0 ? t.next() : t.previous();
    useFind.setState({ total: result.total, current: result.current });
  },
  useSelection(text: string) {
    const query = text.split("\n")[0].slice(0, 200);
    useFind.setState({ query, open: true });
    run(query);
  },
  /** After a tab switch or re-render, search the new content. */
  refresh() {
    const s = useFind.getState();
    if (s.open && s.query) run(s.query);
  },
};
