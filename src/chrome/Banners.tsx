import { useEffect, useState } from "react";
import { actions } from "../app/actions";
import { ipc } from "../ipc";
import { useDocs } from "../store/docs";
import { removeBanner, updateTab, useWorkspace, type Banner } from "../store/workspace";
import { CloseIcon, WarningIcon } from "./icons";

function formatSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return u === 0 ? `${bytes} bytes` : `${v.toFixed(1)} ${units[u]}`;
}

/** Non-modal notices floating above the document (content never shifts). */
export function Banners() {
  const banners = useWorkspace((s) => s.banners);
  const activeId = useWorkspace((s) => s.activeId);
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeId) ?? null);
  const entry = useDocs((s) => (tab?.path ? s.entries[tab.path] : undefined));
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const derived: Banner[] = [];
  if (tab?.path && entry?.payload) {
    if (entry.removed) {
      derived.push({
        id: `removed:${tab.path}`,
        kind: "warning",
        text: `“${tab.title}” was moved or deleted.`,
        detail: "Folio is showing the last version it read.",
        actions: [
          { id: "locate", label: "Locate…" },
          { id: "close", label: "Close" },
        ],
        tabId: tab.id,
        dismissible: false,
      });
    }
    if (entry.payload.large && !tab.renderLarge && tab.kind === "markdown") {
      derived.push({
        id: `large:${tab.path}`,
        kind: "info",
        text: `“${tab.title}” is ${formatSize(entry.payload.size)}, so it opened as source.`,
        actions: [{ id: "render", label: "Render Anyway" }],
        tabId: tab.id,
        dismissible: true,
      });
    }
    if (entry.payload.fallbackEncoding) {
      derived.push({
        id: `encoding:${tab.path}`,
        kind: "info",
        text: "Shown as Windows-1252 because this file isn’t valid UTF-8.",
        tabId: tab.id,
        dismissible: true,
      });
    }
  }
  const visible = [...banners.filter((b) => !b.tabId || b.tabId === activeId), ...derived].filter(
    (b) => !dismissed.has(b.id),
  );

  const run = (banner: Banner, action: string) => {
    switch (action) {
      case "locate":
        void actions.locate(banner.tabId ?? undefined);
        break;
      case "close":
        if (banner.tabId) actions.closeTab(banner.tabId);
        break;
      case "render":
        if (banner.tabId) updateTab(banner.tabId, { renderLarge: true, viewMode: "preview" });
        break;
      case "make-default":
        void ipc
          .makeDefaultApp()
          .then(() => removeBanner(banner.id))
          .catch((err) => {
            removeBanner(banner.id);
            useWorkspace.setState((s) => ({
              banners: [
                ...s.banners,
                { id: "default-failed", kind: "warning", text: "macOS didn’t change the default app.", detail: String(err), tabId: null, dismissible: true },
              ],
            }));
          });
        break;
      case "not-now":
        void ipc.dismissDefaultAppBanner();
        removeBanner(banner.id);
        break;
      default:
        break;
    }
  };

  const dismiss = (banner: Banner) => {
    if (banners.some((b) => b.id === banner.id)) removeBanner(banner.id);
    else setDismissed((d) => new Set(d).add(banner.id));
    if (banner.id === "default-app") void ipc.dismissDefaultAppBanner();
  };

  if (!visible.length) return null;
  return (
    <div className="banners">
      {visible.map((b) => (
        <div key={b.id} className={`banner banner-${b.kind}`} role={b.kind === "warning" ? "alert" : "status"}>
          {b.kind === "warning" && <WarningIcon />}
          <div className="banner-text">
            {b.text}
            {b.detail && <div className="secondary">{b.detail}</div>}
          </div>
          {b.actions && (
            <div className="banner-actions">
              {b.actions.map((a) => (
                <button key={a.id} type="button" className={`push-button${a.primary ? " primary" : ""}`} onClick={() => run(b, a.id)}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {b.dismissible && (
            <button type="button" className="toolbar-button" aria-label="Dismiss" onClick={() => dismiss(b)}>
              <CloseIcon />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Auto-dismisses short-lived notices (missing link targets, anchors). */
export function useTransientBanners() {
  const banners = useWorkspace((s) => s.banners);
  useEffect(() => {
    const transient = banners.filter((b) => b.id === "missing-link" || b.id === "missing-anchor");
    if (!transient.length) return;
    const timer = window.setTimeout(() => transient.forEach((b) => removeBanner(b.id)), 4000);
    return () => window.clearTimeout(timer);
  }, [banners]);
}
