import { useEffect, useState } from "react";
import appIcon from "../assets/icon.svg";
import { signalFirstPaint } from "../app/firstPaint";
import { ipc, on } from "../ipc";
import type { RecentItem } from "../ipc/types";
import { dirname, tildify } from "../lib/paths";
import { FolderIcon, MarkdownDocIcon } from "./icons";

/** New window / New Tab: calm and sparse, on the ivory surface. */
export function Welcome({ active }: { active: boolean }) {
  const [recents, setRecents] = useState<RecentItem[]>([]);

  useEffect(() => {
    let alive = true;
    void ipc.getRecents().then((items) => alive && setRecents(items));
    const unlisten = on("recents-changed", (items) => setRecents(items));
    return () => {
      alive = false;
      void unlisten.then((u) => u());
    };
  }, []);

  useEffect(() => {
    if (active) signalFirstPaint();
  }, [active]);

  return (
    <div className="welcome">
      <img className="welcome-icon" src={appIcon} alt="" draggable={false} />
      <div className="welcome-actions">
        <button type="button" className="push-button large primary" onClick={() => void ipc.showOpenPanel(false)}>
          Open File…
        </button>
        <button type="button" className="push-button large" onClick={() => void ipc.showOpenPanel(true)}>
          Open Folder…
        </button>
      </div>
      {recents.length > 0 && (
        <section className="welcome-recents" aria-label="Recent">
          <h2>Recent</h2>
          <div role="list">
            {recents.slice(0, 8).map((item) => (
              <div
                key={item.path}
                role="listitem"
                className="row"
                tabIndex={0}
                title={item.path}
                onClick={() => void ipc.openGranted(item.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void ipc.openGranted(item.path);
                  }
                }}
              >
                <span className="row-icon">{item.isFolder ? <FolderIcon /> : <MarkdownDocIcon />}</span>
                <span className="row-label">{item.name}</span>
                <span className="detail">{tildify(dirname(item.path))}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="welcome-hint">Drop Markdown files or folders anywhere in this window.</p>
    </div>
  );
}
