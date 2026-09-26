/**
 * The window stays hidden until its first document (or the Welcome view)
 * has painted, so it appears complete: no white flash, no layout shift.
 */
let signalled = false;
const waiters: (() => void)[] = [];

export function signalFirstPaint(): void {
  if (signalled) return;
  signalled = true;
  waiters.splice(0).forEach((w) => w());
}

export function hasFirstPainted(): boolean {
  return signalled;
}

export function onFirstPaint(callback: () => void): void {
  if (signalled) callback();
  else waiters.push(callback);
}

/**
 * Tells Rust the window can be shown. While the window is hidden, WebKit
 * doesn't run animation frames (or paint), so waiting for a frame would
 * stall until Rust's fallback timer: lay out now and report right away;
 * the first frame is painted as the window appears. When visible (a
 * window opened later), wait for a real paint.
 */
export function reportReady(send: () => void): void {
  let sent = false;
  const once = () => {
    if (sent) return;
    sent = true;
    send();
  };
  if (document.visibilityState === "visible") {
    requestAnimationFrame(() => requestAnimationFrame(once));
    // rAF can be throttled even when "visible" (occluded windows).
    setTimeout(once, 100);
  } else {
    // Timers are throttled in hidden pages too, so report synchronously.
    const t0 = performance.now();
    void document.body.offsetHeight;
    layoutMs = performance.now() - t0;
    once();
  }
}

/** Time the forced first layout took (for the perf log), if one ran. */
export let layoutMs: number | null = null;
