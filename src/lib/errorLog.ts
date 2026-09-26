/**
 * Sends uncaught errors, unhandled rejections and console errors/warnings to
 * Folio's local log file (Help ▸ Show Logs), where they're useful for bug
 * reports. Nothing is sent anywhere else.
 */
import { ipc } from "../ipc";

let installed = false;
let budget = 200; // per window lifetime, so a render loop can't flood the log

function send(level: "error" | "warn", parts: unknown[]) {
  if (budget <= 0) return;
  budget--;
  const text = parts
    .map((p) => (p instanceof Error ? `${p.message}\n${p.stack ?? ""}` : typeof p === "string" ? p : safeJson(p)))
    .join(" ");
  void ipc.log(level, text).catch(() => {});
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function installErrorLog(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => send("error", [e.error ?? e.message]));
  window.addEventListener("unhandledrejection", (e) => send("error", ["Unhandled rejection:", e.reason]));
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      send(level, args);
    };
  }
}
