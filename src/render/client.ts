/**
 * Main-thread client for the render worker. The worker is started at boot,
 * before the first document has been read, so its startup overlaps IPC.
 */
import type { RenderOptions, RenderOutput, WorkerRequest, WorkerResponse } from "./types";

type HighlightListener = (blocks: { key: string; html: string }[]) => void;

interface Pending {
  resolve: (output: RenderOutput) => void;
  reject: (error: Error) => void;
  key: string;
}

export class RenderClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private latestByKey = new Map<string, number>();
  private highlightListeners = new Map<string, Set<HighlightListener>>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "render" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      console.error("render worker error", event.message);
      for (const [id, p] of this.pending) {
        p.reject(new Error(event.message || "The renderer stopped unexpectedly."));
        this.pending.delete(id);
      }
    };
  }

  private onMessage(msg: WorkerResponse) {
    if (msg.type === "highlighted") {
      if (this.latestByKey.get(msg.key) !== msg.id) return;
      this.highlightListeners.get(msg.key)?.forEach((l) => l(msg.blocks));
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === "rendered") p.resolve(msg.output);
    else p.reject(new Error(msg.message));
  }

  /**
   * Renders `text` for document `key`. A newer render for the same key
   * supersedes older ones (they reject with `Superseded`).
   */
  render(key: string, text: string, options: RenderOptions): Promise<RenderOutput> {
    const id = this.nextId++;
    const previous = this.latestByKey.get(key);
    if (previous !== undefined) {
      const p = this.pending.get(previous);
      if (p) {
        this.pending.delete(previous);
        p.reject(new Superseded());
      }
    }
    this.latestByKey.set(key, id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, key });
      const req: WorkerRequest = { type: "render", id, key, text, options };
      this.worker.postMessage(req);
    });
  }

  onHighlight(key: string, listener: HighlightListener): () => void {
    let set = this.highlightListeners.get(key);
    if (!set) {
      set = new Set();
      this.highlightListeners.set(key, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  warm(langs: string[]) {
    const req: WorkerRequest = { type: "warm", langs };
    this.worker.postMessage(req);
  }
}

export class Superseded extends Error {
  constructor() {
    super("superseded");
    this.name = "Superseded";
  }
}

let client: RenderClient | null = null;

export function renderClient(): RenderClient {
  client ??= new RenderClient();
  return client;
}
