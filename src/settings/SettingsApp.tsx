import "./settings.css";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ipc, on } from "../ipc";
import type { CustomTheme, DefaultAppStatus, EditorInfo, Settings } from "../ipc/types";
import { useSettings } from "../store/settings";

type Pane = "general" | "appearance" | "reading" | "advanced";

const PANES: { id: Pane; label: string; icon: React.ReactNode }[] = [
  {
    id: "general",
    label: "General",
    icon: (
      <svg className="icon" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="3.2" />
        <path d="M11 2.5v2.6M11 16.9v2.6M19.5 11h-2.6M5.1 11H2.5M17 5l-1.8 1.8M6.8 15.2 5 17M17 17l-1.8-1.8M6.8 6.8 5 5" />
        <circle cx="11" cy="11" r="6.4" />
      </svg>
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: (
      <svg className="icon" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <path d="M11 3a8 8 0 0 0 0 16z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: "reading",
    label: "Reading",
    icon: (
      <svg className="icon" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <path d="M3 5.5c2.8-1.3 5.5-1.3 8 .4 2.5-1.7 5.2-1.7 8-.4v11c-2.8-1.3-5.5-1.3-8 .4-2.5-1.7-5.2-1.7-8-.4z" />
        <path d="M11 5.9v11" />
      </svg>
    ),
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: (
      <svg className="icon" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <path d="M4 6.5h9M16.5 6.5H18M4 15.5h2.5M10 15.5h8" />
        <circle cx="14.75" cy="6.5" r="1.9" />
        <circle cx="8.25" cy="15.5" r="1.9" />
      </svg>
    ),
  },
];

function useSettingsSync() {
  const settings = useSettings((s) => s.settings);
  useEffect(() => {
    void ipc.getSettings().then((s) => useSettings.getState().setSettings(s));
    const unlisten = on("settings-changed", (s) => useSettings.getState().setSettings(s));
    return () => void unlisten.then((u) => u());
  }, []);
  const update = (patch: Partial<Settings>) => {
    useSettings.getState().setSettings({ ...useSettings.getState().settings, ...patch });
    void ipc.updateSettings(patch);
  };
  return [settings, update] as const;
}

export function SettingsApp() {
  const [settings, update] = useSettingsSync();
  const initial = (PANES.find((p) => p.id === settings.lastSettingsPane)?.id ?? "general") as Pane;
  const [pane, setPane] = useState<Pane>(initial);

  useEffect(() => {
    const label = PANES.find((p) => p.id === pane)!.label;
    void getCurrentWindow().setTitle(label);
    document.title = label;
  }, [pane]);

  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => void ipc.windowReady()));
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "w") {
        e.preventDefault();
        void ipc.closeWindow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (p: Pane) => {
    setPane(p);
    void ipc.updateSettings({ lastSettingsPane: p });
  };

  return (
    <div className="settings">
      <nav className="settings-toolbar" role="tablist" aria-label="Settings">
        {PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={pane === p.id}
            className={pane === p.id ? "is-selected" : ""}
            onClick={() => choose(p.id)}
          >
            {p.icon}
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      <main className="settings-body" role="tabpanel">
        {pane === "general" && <General settings={settings} update={update} />}
        {pane === "appearance" && <Appearance settings={settings} update={update} />}
        {pane === "reading" && <Reading settings={settings} update={update} />}
        {pane === "advanced" && <Advanced settings={settings} update={update} />}
      </main>
    </div>
  );
}

interface PaneProps {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

function Row({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="form-row">
      <div className="form-label">{label}</div>
      <div className="form-control">
        {children}
        {note && <div className="form-note">{note}</div>}
      </div>
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function Radio<T extends string>({ value, options, onChange, name }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; name: string }) {
  return (
    <div className="radio-group" role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className="check">
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function General({ settings, update }: PaneProps) {
  const [status, setStatus] = useState<DefaultAppStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cli, setCli] = useState<string | null>(null);

  useEffect(() => {
    void ipc.defaultAppStatus().then(setStatus);
  }, []);

  const makeDefault = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setStatus(await ipc.makeDefaultApp());
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  const defaultText = !status
    ? "Checking…"
    : !status.supported
      ? "Available when Folio runs from its app bundle."
      : status.isDefault
        ? "Folio opens Markdown files."
        : `Markdown files open in ${status.types.find((t) => t.handler && !t.isDefault)?.handler ?? "another app"}.`;

  return (
    <div className="form">
      <Row
        label="Default app:"
        note={
          status?.types.length ? (
            <span title={status.types.map((t) => `${t.uti}: ${t.extensions.join(", ")}`).join("\n")}>
              {status.types.map((t) => t.extensions.map((e) => `.${e}`).join(" ")).filter(Boolean).join(" · ")}
            </span>
          ) : undefined
        }
      >
        <div className="inline">
          <span className={status?.isDefault ? "status-ok" : undefined}>{defaultText}</span>
          {status?.supported && !status.isDefault && (
            <button type="button" className="push-button" disabled={busy} onClick={() => void makeDefault()}>
              Make Default
            </button>
          )}
        </div>
        {message && <div className="form-note error">{message}</div>}
      </Row>
      <Row label="Open files:">
        <Radio
          name="open"
          value={settings.openFilesIn}
          onChange={(v) => update({ openFilesIn: v })}
          options={[
            { value: "tabs", label: "As tabs in the frontmost window" },
            { value: "windows", label: "In new windows" },
          ]}
        />
      </Row>
      <Row label="Restore windows:" note="“System” follows “Close windows when quitting an application” in System Settings ▸ Desktop & Dock.">
        <select value={settings.sessionRestore} onChange={(e) => update({ sessionRestore: e.target.value as Settings["sessionRestore"] })}>
          <option value="system">System</option>
          <option value="always">Always</option>
          <option value="never">Never</option>
        </select>
      </Row>
      <Row label="Open documents in:">
        <select value={settings.defaultViewMode} onChange={(e) => update({ defaultViewMode: e.target.value as Settings["defaultViewMode"] })}>
          <option value="preview">Preview</option>
          <option value="code">Code</option>
          <option value="split">Split</option>
        </select>
        <Check checked={settings.rememberModePerFile} onChange={(v) => update({ rememberModePerFile: v })}>
          Remember the view for each file
        </Check>
      </Row>
      <Row label="Command line:" note={cli ?? "Opens files with `folio README.md`, folders with `folio .`."}>
        <button
          type="button"
          className="push-button"
          onClick={() => void ipc.installCli().then((r) => setCli(r.message))}
        >
          Install Command Line Tool…
        </button>
      </Row>
    </div>
  );
}

function Appearance({ settings, update }: PaneProps) {
  const [themes, setThemes] = useState<CustomTheme[]>([]);
  useEffect(() => {
    void ipc.listThemes().then(setThemes);
    const unlisten = on("themes-changed", setThemes);
    return () => void unlisten.then((u) => u());
  }, []);
  return (
    <div className="form">
      <Row label="Theme:">
        <select value={settings.theme} onChange={(e) => update({ theme: e.target.value })}>
          <option value="claude">Claude</option>
          <option value="github">GitHub</option>
          <option value="paper">Paper</option>
          {themes.length > 0 && <option disabled>──────────</option>}
          {themes.map((t) => (
            <option key={t.name} value={`custom:${t.name}`}>
              {t.name}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Appearance:">
        <Radio
          name="appearance"
          value={settings.appearance}
          onChange={(v) => update({ appearance: v })}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Row>
      <Row label="Custom themes:" note="CSS files in this folder appear in the Theme menu and reload when saved.">
        <button type="button" className="push-button" onClick={() => void ipc.openThemesFolder()}>
          Open Themes Folder
        </button>
      </Row>
    </div>
  );
}

function Reading({ settings, update }: PaneProps) {
  return (
    <div className="form">
      <Row label="Font:">
        <select value={settings.fontFamily} onChange={(e) => update({ fontFamily: e.target.value as Settings["fontFamily"] })}>
          <option value="serif">Serif</option>
          <option value="sans">Sans</option>
          <option value="mono">Mono</option>
        </select>
      </Row>
      <Row label="Size:">
        <div className="inline">
          <input type="range" min={13} max={26} step={1} value={settings.fontSize} onChange={(e) => update({ fontSize: Number(e.target.value) })} aria-label="Font size" />
          <span className="value">{settings.fontSize} pt</span>
        </div>
      </Row>
      <Row label="Line height:">
        <div className="inline">
          <input
            type="range"
            min={1.3}
            max={2}
            step={0.05}
            value={settings.lineHeight}
            onChange={(e) => update({ lineHeight: Number(e.target.value) })}
            aria-label="Line height"
          />
          <span className="value">{settings.lineHeight.toFixed(2)}</span>
        </div>
      </Row>
      <Row label="Width:">
        <select value={settings.readingWidth} onChange={(e) => update({ readingWidth: e.target.value as Settings["readingWidth"] })}>
          <option value="narrow">Narrow</option>
          <option value="medium">Medium</option>
          <option value="wide">Wide</option>
          <option value="full">Full</option>
        </select>
      </Row>
      <Row label="Front matter:">
        <select value={settings.frontMatter} onChange={(e) => update({ frontMatter: e.target.value as Settings["frontMatter"] })}>
          <option value="hidden">Hidden</option>
          <option value="card">Metadata card</option>
        </select>
      </Row>
      <Row label="Live reload:">
        <Check checked={settings.highlightChanges} onChange={(v) => update({ highlightChanges: v })}>
          Briefly highlight changed paragraphs
        </Check>
      </Row>
      <Row label="Status bar:">
        <Check checked={settings.statusBar} onChange={(v) => update({ statusBar: v })}>
          Show word count, reading time and lines
        </Check>
      </Row>
    </div>
  );
}

function Advanced({ settings, update }: PaneProps) {
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  useEffect(() => {
    void ipc.listEditors().then(setEditors);
  }, []);
  return (
    <div className="form">
      <Row label="Remote images:">
        <Check checked={settings.remoteImages} onChange={(v) => update({ remoteImages: v })}>
          Load images from the internet
        </Check>
      </Row>
      <Row label="Editor:" note="Used by File ▸ Open in Editor (⇧⌘E).">
        <select value={settings.editor} onChange={(e) => update({ editor: e.target.value })}>
          <option value="auto">Automatic</option>
          {editors.map((ed) => (
            <option key={ed.id} value={ed.id}>
              {ed.name}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Logs:">
        <button type="button" className="push-button" onClick={() => void ipc.showLogs()}>
          Show Logs
        </button>
      </Row>
      <Row label="Reset:">
        <ResetButton />
      </Row>
    </div>
  );
}

function ResetButton() {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="push-button" onClick={() => setConfirming(true)}>
        Reset All Settings…
      </button>
    );
  }
  return (
    <div className="inline">
      <span>Reset every setting to its default?</span>
      <button type="button" className="push-button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
      <button
        type="button"
        className="push-button primary"
        onClick={() => {
          setConfirming(false);
          void ipc.resetSettings();
        }}
      >
        Reset
      </button>
    </div>
  );
}
