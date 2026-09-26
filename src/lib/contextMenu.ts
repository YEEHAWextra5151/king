/**
 * Native context menus: the frontend describes the items, Rust shows a real
 * NSMenu, and the chosen item comes back as a `context-menu` event.
 */
import { ipc, on } from "../ipc";

export type MenuEntry =
  | { separator: true }
  | { label: string; action: () => void; enabled?: boolean; checked?: boolean };

const pending = new Map<string, { actions: Map<string, () => void>; expires: number }>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  void on("context-menu", ({ token, item }) => {
    const menu = pending.get(token);
    pending.delete(token);
    menu?.actions.get(item)?.();
  });
}

export function showContextMenu(entries: MenuEntry[]): void {
  listen();
  const now = Date.now();
  for (const [token, menu] of pending) if (menu.expires < now) pending.delete(token);
  const token = Math.random().toString(36).slice(2, 10);
  const actions = new Map<string, () => void>();
  const items = entries.map((entry, index) => {
    if ("separator" in entry) return { separator: true };
    const id = String(index);
    actions.set(id, entry.action);
    return { id, label: entry.label, enabled: entry.enabled ?? true, checked: entry.checked };
  });
  pending.set(token, { actions, expires: now + 5 * 60_000 });
  void ipc.popupMenu(token, items);
}
