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

export function onFirstPaint(callback: () => void): void {
  if (signalled) callback();
  else waiters.push(callback);
}
