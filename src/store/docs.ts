/**
 * Document contents, shared by every tab in this window that shows a path.
 * Reads go through Rust (`read_document`), which enforces the access policy.
 */
import { create } from "zustand";
import { ipc } from "../ipc";
import type { DocErrorCode, DocumentPayload } from "../ipc/types";
import { renderClient } from "../render/client";
import { warmMathFonts } from "../app/warmFonts";
import { loadKatexCss, mayHaveMath } from "../views/katexStyles";
import { getSettings } from "./settings";
import { useWorkspace } from "./workspace";

export interface DocEntry {
  path: string;
  status: "loading" | "ready" | "downloading" | "error";
  /** Last good content; kept when the file is moved or deleted. */
  payload: DocumentPayload | null;
  error: { code: DocErrorCode; message: string } | null;
  /** The file was moved or deleted after it loaded. */
  removed: boolean;
  /** Increments on every successful (re)load. */
  version: number;
  /** Loaded as source only (a text/code file, or a large Markdown file). */
  asText: boolean;
}

interface DocsStore {
  entries: Record<string, DocEntry>;
}

export const useDocs = create<DocsStore>(() => ({ entries: {} }));

const inflight = new Map<string, Promise<void>>();

function patch(path: string, update: Partial<DocEntry>) {
  useDocs.setState((s) => {
    const prev = s.entries[path] ?? {
      path,
      status: "loading",
      payload: null,
      error: null,
      removed: false,
      version: 0,
      asText: false,
    };
    return { entries: { ...s.entries, [path]: { ...prev, ...update } } };
  });
}

export function getDoc(path: string): DocEntry | undefined {
  return useDocs.getState().entries[path];
}

/**
 * Loads (or reloads) `path`. Concurrent calls share one read. A reload
 * that fails keeps the last good content visible.
 */
export function loadDocument(path: string, options: { asText?: boolean; reload?: boolean } = {}): Promise<void> {
  const existing = inflight.get(path);
  if (existing && !options.reload) return existing;
  const prev = getDoc(path);
  if (!prev) patch(path, { status: "loading", asText: !!options.asText });
  const task = ipc
    .readDocument(path, options.asText ?? prev?.asText ?? false)
    .then((result) => {
      const current = getDoc(path);
      if (result.status === "ready") {
        const { status: _status, ...payload } = result;
        const onScreen = useWorkspace.getState().tabs.find((t) => t.id === useWorkspace.getState().activeId)?.path === path;
        if (!current?.payload && payload.kind === "markdown" && !payload.large && onScreen) {
          // Start rendering the document on screen now instead of when its
          // view mounts; the view's identical request shares the result.
          void renderClient()
            .render(path, payload.text, { frontMatter: getSettings().frontMatter })
            .catch(() => {});
          if (mayHaveMath(payload.text)) void loadKatexCss().then(warmMathFonts);
        }
        patch(path, {
          status: "ready",
          payload,
          error: null,
          removed: false,
          version: (current?.version ?? 0) + 1,
        });
      } else if (result.status === "downloading") {
        patch(path, { status: current?.payload ? "ready" : "downloading" });
      } else if (current?.payload && options.reload) {
        // Keep the last content; the watcher reports removals separately.
        patch(path, { removed: result.code === "notFound" });
      } else {
        patch(path, { status: "error", error: { code: result.code, message: result.message } });
      }
    })
    .catch((err: unknown) => {
      patch(path, {
        status: "error",
        error: { code: "other", message: err instanceof Error ? err.message : String(err) },
      });
    })
    .finally(() => {
      if (inflight.get(path) === task) inflight.delete(path);
    });
  inflight.set(path, task);
  return task;
}

export function markRemoved(path: string) {
  if (getDoc(path)) patch(path, { removed: true });
}

/** Drops entries no tab uses anymore. */
export function pruneDocs(inUse: Set<string>) {
  const entries = useDocs.getState().entries;
  const next: Record<string, DocEntry> = {};
  let changed = false;
  for (const [path, entry] of Object.entries(entries)) {
    if (inUse.has(path)) {
      next[path] = entry;
    } else {
      changed = true;
      renderClient().forget(path);
    }
  }
  if (changed) useDocs.setState({ entries: next });
}
