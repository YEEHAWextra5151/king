import { useEffect, useState } from "react";
import { useDocs } from "../store/docs";
import { useSettings } from "../store/settings";
import { useWorkspace } from "../store/workspace";

function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const minute = 60_000;
  if (diff < minute) return "just now";
  if (diff < 60 * minute) return `${Math.round(diff / minute)} min ago`;
  const date = new Date(ms);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `today at ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday at ${time}`;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Optional status bar: words, reading time, lines, last modified. */
export function StatusBar() {
  const show = useSettings((s) => s.settings.statusBar);
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeId) ?? null);
  const info = useWorkspace((s) => (s.activeId ? s.info[s.activeId] : undefined));
  const payload = useDocs((s) => (tab?.path ? s.entries[tab.path]?.payload : undefined));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!show) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [show]);

  if (!show) return null;
  const lines = payload ? payload.text.split("\n").length - (payload.text.endsWith("\n") ? 1 : 0) : 0;
  const words = info?.words ?? 0;
  const minutes = Math.max(1, Math.round(words / 230));
  return (
    <footer className="statusbar" role="status" aria-label="Document information">
      {payload ? (
        <>
          {tab?.kind === "markdown" && <span>{words.toLocaleString()} words</span>}
          {tab?.kind === "markdown" && <span>{minutes} min read</span>}
          <span>{lines.toLocaleString()} lines</span>
          <span className="spacer" />
          {payload.encoding !== "utf-8" && <span>{payload.encoding.toUpperCase()}</span>}
          {payload.lineEnding === "crlf" && <span>CRLF</span>}
          {!tab?.isStdin && <span>Modified {relativeTime(payload.modifiedMs, now)}</span>}
        </>
      ) : (
        <span />
      )}
    </footer>
  );
}
