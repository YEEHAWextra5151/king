/**
 * Opt-in timings (FOLIO_PERF=1) for what can't be measured from outside the
 * app: tab switches and live reloads, from the triggering event to the frame
 * that shows the result. Written to the local log as `perf:` lines.
 */
import { boot } from "../boot";
import { ipc } from "../ipc";

export const perfEnabled = !!boot.perf;
const starts = new Map<string, number>();

export function perfStart(key: string): void {
  if (perfEnabled) starts.set(key, performance.now());
}

/** Logs `label Nms` once the next frame has been painted. */
export function perfEnd(key: string, label: string): void {
  if (!perfEnabled) return;
  const start = starts.get(key);
  if (start === undefined) return;
  starts.delete(key);
  requestAnimationFrame(() =>
    setTimeout(() => void ipc.perfMark(`${label} ${(performance.now() - start).toFixed(1)}ms`), 0),
  );
}
