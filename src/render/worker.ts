/// <reference lib="webworker" />
/**
 * The render worker: parsing and highlighting never block the main thread.
 * Requests for the same document supersede each other; errors stay
 * contained to the request (and so to its tab).
 */
import { highlightPending, renderDocument, warm } from "./renderer";
import type { WorkerRequest, WorkerResponse } from "./types";

declare const self: DedicatedWorkerGlobalScope;

const latest = new Map<string, number>();

function post(message: WorkerResponse) {
  self.postMessage(message);
}

async function handleRender(req: Extract<WorkerRequest, { type: "render" }>) {
  latest.set(req.key, req.id);
  try {
    const { output, grammars } = await renderDocument(req.text, req.options);
    if (latest.get(req.key) !== req.id) return; // superseded
    post({ type: "rendered", id: req.id, key: req.key, output });
    if (grammars && output.pending.length > 0) {
      await grammars;
      if (latest.get(req.key) !== req.id) return;
      const blocks = highlightPending(output.pending);
      if (blocks.length > 0) post({ type: "highlighted", id: req.id, key: req.key, blocks });
    }
  } catch (err) {
    post({
      type: "error",
      id: req.id,
      key: req.key,
      message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (req.type === "render") void handleRender(req);
  else if (req.type === "warm") void warm(req.langs);
};
