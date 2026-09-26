/**
 * Boot data injected by Rust as an initialization script (before any page
 * script runs), so the theme is resolved before first paint.
 */
import type { Boot, Settings } from "./ipc/types";

const DEFAULT_SETTINGS: Settings = {
  openFilesIn: "tabs",
  sessionRestore: "system",
  defaultViewMode: "preview",
  rememberModePerFile: false,
  theme: "claude",
  appearance: "system",
  fontFamily: "serif",
  fontSize: 17,
  lineHeight: 1.65,
  readingWidth: "medium",
  frontMatter: "hidden",
  highlightChanges: true,
  statusBar: false,
  textZoom: 1,
  softWrap: true,
  remoteImages: true,
  editor: "auto",
  defaultAppBannerShown: true,
  lastSettingsPane: "general",
  lastWindowSize: null,
};

declare global {
  interface Window {
    __FOLIO_BOOT__?: Boot;
  }
}

export const boot: Boot = window.__FOLIO_BOOT__ ?? {
  label: new URLSearchParams(location.search).get("window") === "settings" ? "settings" : "doc-dev",
  kind: new URLSearchParams(location.search).get("window") === "settings" ? "settings" : "document",
  platform: /Mac/.test(navigator.userAgent) ? "macos" : "linux",
  version: "dev",
  settings: DEFAULT_SETTINGS,
  customThemeCss: null,
  trafficLights: { x: 16, y: 20 },
  toolbarHeight: 44,
};

export const isMac = boot.platform === "macos";

let customStyle: HTMLStyleElement | null = null;

/** Reflects reading/appearance settings onto <html> (attributes + vars). */
export function applySettings(s: Settings, customCss: string | null = null): void {
  const root = document.documentElement;
  const custom = s.theme.startsWith("custom:");
  root.dataset.platform = boot.platform;
  root.dataset.window = boot.kind;
  root.dataset.theme = custom ? "claude" : s.theme;
  root.dataset.font = s.fontFamily;
  root.dataset.width = s.readingWidth;
  root.dataset.highlightChanges = String(s.highlightChanges);
  // Themes set their own base size; the setting overrides only when changed.
  root.style.setProperty("--doc-zoom", String(s.textZoom));
  if (s.fontSize !== 17 || s.theme === "claude" || custom) {
    root.style.setProperty("--doc-size", `${s.fontSize}px`);
  } else {
    root.style.removeProperty("--doc-size");
  }
  if (Math.abs(s.lineHeight - 1.65) > 0.001 || s.theme === "claude" || custom) {
    root.style.setProperty("--doc-line-height", String(s.lineHeight));
  } else {
    root.style.removeProperty("--doc-line-height");
  }
  if (custom && customCss !== null) {
    customStyle ??= document.head.appendChild(document.createElement("style"));
    customStyle.id = "folio-custom-theme";
    customStyle.textContent = customCss;
  } else if (!custom && customStyle) {
    customStyle.textContent = "";
  }
}

/** Traffic-light inset for the toolbar (≈ the three buttons plus margins). */
export function applyChromeMetrics(): void {
  const root = document.documentElement;
  const inset = isMac ? Math.round(boot.trafficLights.x + 3 * 14 + 2 * 6 + 12) : 8;
  root.style.setProperty("--traffic-light-inset", `${inset}px`);
  root.style.setProperty("--toolbar-height", `${boot.toolbarHeight}px`);
}
