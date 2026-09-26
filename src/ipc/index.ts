/**
 * The one typed IPC module: every Rust command and event the frontend
 * uses. Nothing else calls `invoke` or `listen` directly.
 *
 * Events are always listened to on the current webview window: Tauri's
 * global `listen()` also receives events emitted to *other* windows.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type {
  CliInstallResult,
  CustomTheme,
  DefaultAppStatus,
  EditorInfo,
  EventMap,
  FolderListing,
  GrantedImage,
  LinkTarget,
  OpenRequest,
  PopupItem,
  ReadingPosition,
  ReadResult,
  RecentItem,
  Settings,
  TabSnapshot,
  ViewMode,
  WindowInit,
  WindowSnapshot,
} from "./types";

export * from "./types";

export const ipc = {
  // Window lifecycle
  takeWindowInit: () => invoke<WindowInit>("take_window_init"),
  takePendingOpens: () => invoke<OpenRequest[]>("take_pending_opens"),
  windowReady: () => invoke<void>("window_ready"),
  registryUpdate: (snapshot: WindowSnapshot) => invoke<void>("registry_update", { snapshot }),
  perfMark: (name: string) => invoke<void>("perf_mark", { name }),
  toolbarDoubleClick: () => invoke<void>("toolbar_double_click"),
  startWindowDrag: () => invoke<void>("start_window_drag"),
  closeWindow: () => invoke<void>("close_window"),
  newWindow: () => invoke<void>("new_window"),
  openSettings: () => invoke<void>("open_settings"),

  // Documents
  readDocument: (path: string, asText = false) => invoke<ReadResult>("read_document", { path, asText }),
  resolveLink: (from: string, href: string, root: string | null) =>
    invoke<LinkTarget>("resolve_link", { from, href, root }),
  allowImages: (doc: string, srcs: string[], root: string | null) =>
    invoke<Record<string, GrantedImage | null>>("allow_images", { doc, srcs, root }),
  imageDataUrls: (paths: string[]) => invoke<Record<string, string>>("image_data_urls", { paths }),
  listFolder: (root: string) => invoke<FolderListing>("list_folder", { root }),

  // Opening
  openDropped: (paths: string[], insertAt: number | null) => invoke<void>("open_dropped", { paths, insertAt }),
  openGranted: (path: string, options: { newWindow?: boolean; view?: ViewMode } = {}) =>
    invoke<void>("open_granted", { path, newWindow: options.newWindow ?? false, view: options.view ?? null }),
  showOpenPanel: (foldersOnly = false) => invoke<void>("show_open_panel", { foldersOnly }),
  locateFile: (path: string) => invoke<string | null>("locate_file", { path }),
  moveTabToNewWindow: (tab: TabSnapshot) => invoke<string>("move_tab_to_new_window", { tab }),
  mergeWindows: () => invoke<void>("merge_windows"),
  listOpenDocuments: () => invoke<{ path: string; title: string; window: string }[]>("list_open_documents"),

  // Finder, browser, editor
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  openInEditor: (path: string, line?: number) => invoke<void>("open_in_editor", { path, line: line ?? null }),
  listEditors: () => invoke<EditorInfo[]>("list_editors"),
  showLogs: () => invoke<void>("show_logs_folder"),

  // Menus
  popupMenu: (token: string, items: PopupItem[]) => invoke<void>("popup_menu", { token, items }),
  popupPathMenu: (path: string) => invoke<void>("popup_path_menu", { path }),

  // Print, export, clipboard
  printWindow: () => invoke<void>("print_window"),
  exportHtml: (html: string, suggestedName: string, directory: string | null) =>
    invoke<string | null>("export_html", { html, suggestedName, directory }),
  copyToClipboard: (text: string, html?: string) => invoke<void>("copy_to_clipboard", { text, html: html ?? null }),

  // Settings, recents, themes
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Settings>) => invoke<Settings>("update_settings", { patch }),
  resetSettings: () => invoke<Settings>("reset_settings"),
  getRecents: () => invoke<RecentItem[]>("get_recents"),
  clearRecents: () => invoke<void>("clear_recents"),
  getReadingPosition: (path: string) => invoke<ReadingPosition | null>("get_reading_position", { path }),
  saveReadingPosition: (position: ReadingPosition) => invoke<void>("save_reading_position", { position }),
  listThemes: () => invoke<CustomTheme[]>("list_themes"),
  openThemesFolder: () => invoke<void>("open_themes_folder"),

  // Default app, CLI
  defaultAppStatus: () => invoke<DefaultAppStatus>("default_app_status"),
  makeDefaultApp: () => invoke<DefaultAppStatus>("make_default_app"),
  dismissDefaultAppBanner: () => invoke<void>("dismiss_default_app_banner"),
  installCli: () => invoke<CliInstallResult>("install_cli"),
};

/** Listens on this window only (see the module comment). */
export function on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<EventMap[K]>(event, (e) => handler(e.payload));
}

/** URL for a granted local file (asset protocol). */
export function assetUrl(path: string): string {
  return convertFileSrc(path, "asset");
}
