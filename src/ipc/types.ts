/** TypeScript mirrors of the Rust types that cross IPC (serde camelCase). */

export type ViewMode = "preview" | "code" | "split";
export type Appearance = "system" | "light" | "dark";
export type FontFamily = "serif" | "sans" | "mono";
export type ReadingWidth = "narrow" | "medium" | "wide" | "full";

export interface Settings {
  openFilesIn: "tabs" | "windows";
  sessionRestore: "system" | "always" | "never";
  defaultViewMode: ViewMode;
  rememberModePerFile: boolean;
  theme: string;
  appearance: Appearance;
  fontFamily: FontFamily;
  fontSize: number;
  lineHeight: number;
  readingWidth: ReadingWidth;
  frontMatter: "hidden" | "card";
  highlightChanges: boolean;
  statusBar: boolean;
  textZoom: number;
  softWrap: boolean;
  remoteImages: boolean;
  editor: string;
  defaultAppBannerShown: boolean;
  lastSettingsPane: string;
  lastWindowSize: [number, number] | null;
}

export type TargetKind = "markdown" | "text" | "folder" | "missing";

export interface OpenRequest {
  path: string;
  kind: TargetKind;
  view: ViewMode | null;
  line: number | null;
  isStdin: boolean;
  insertAt: number | null;
  activate: boolean;
  readme: string | null;
  tab: TabSnapshot | null;
}

export interface SidebarState {
  visible: boolean;
  width: number;
  pane: "outline" | "files";
}

export interface WindowInit {
  tabs: TabSnapshot[];
  activeTabId: string | null;
  folder: string | null;
  sidebar: SidebarState | null;
  notices: string[];
  showDefaultAppBanner: boolean;
}

export interface HistoryEntry {
  path: string;
  kind: "markdown" | "text";
  /** Fractional source line at the top of the viewport. */
  anchor: number;
}

/** What Rust keeps about a tab (registry, session, moves). */
export interface TabSnapshot {
  id: string;
  path: string | null;
  title: string;
  isStdin: boolean;
  viewMode: ViewMode;
  kind?: "markdown" | "text";
  anchor?: number;
  splitRatio?: number;
  history?: { back: HistoryEntry[]; forward: HistoryEntry[] };
}

export interface MenuState {
  hasDocument: boolean;
  isMarkdown: boolean;
  viewMode: ViewMode;
  canGoBack: boolean;
  canGoForward: boolean;
  hasHeadings: boolean;
  hasClosedTabs: boolean;
  tabCount: number;
  sidebarVisible: boolean;
  sidebarPane: string;
  hasFolder: boolean;
}

export interface WindowSnapshot {
  tabs: TabSnapshot[];
  activeTabId: string | null;
  folder: string | null;
  sidebar: SidebarState;
  menu: MenuState;
}

export type DocErrorCode =
  | "notFound"
  | "permissionDenied"
  | "isDirectory"
  | "tooLarge"
  | "binary"
  | "notAllowed"
  | "other";

export interface DocumentPayload {
  path: string;
  name: string;
  text: string;
  kind: "markdown" | "text";
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
  hadBom: boolean;
  fallbackEncoding: boolean;
  lineEnding: "lf" | "crlf" | "cr" | "mixed" | "none";
  size: number;
  modifiedMs: number;
  large: boolean;
}

export type ReadResult =
  | ({ status: "ready" } & DocumentPayload)
  | { status: "downloading"; path: string; name: string }
  | { status: "error"; path: string; name: string; code: DocErrorCode; message: string };

export type LinkKind = "markdown" | "text" | "directory" | "other" | "missing" | "external" | "blocked";

export interface LinkTarget {
  kind: LinkKind;
  path: string | null;
  readme: string | null;
  fragment: string | null;
  url: string | null;
}

export interface GrantedImage {
  path: string;
  width: number | null;
  height: number | null;
}

export interface FolderNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FolderNode[];
}

export interface FolderListing {
  root: FolderNode;
  fileCount: number;
  truncated: boolean;
}

export interface RecentItem {
  path: string;
  name: string;
  isFolder: boolean;
}

export interface ReadingPosition {
  path: string;
  line: number;
  viewMode: ViewMode | null;
}

export interface CustomTheme {
  name: string;
  css: string;
}

export interface TypeStatus {
  uti: string;
  extensions: string[];
  handler: string | null;
  isDefault: boolean;
}

export interface DefaultAppStatus {
  supported: boolean;
  isDefault: boolean;
  types: TypeStatus[];
}

export interface EditorInfo {
  id: string;
  name: string;
}

export interface CliInstallResult {
  ok: boolean;
  path: string | null;
  message: string;
}

export interface PopupItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  separator?: boolean;
  checked?: boolean;
}

export interface Boot {
  label: string;
  kind: "document" | "settings";
  platform: "macos" | "linux" | "windows";
  version: string;
  settings: Settings;
  customThemeCss: string | null;
  trafficLights: { x: number; y: number };
  toolbarHeight: number;
}

// ─── Events ────────────────────────────────────────────────────────────────

export interface MenuActionEvent {
  action: string;
  arg: unknown;
}

export interface DocumentChangedEvent {
  path: string;
  modifiedMs: number;
}

export interface DocumentRemovedEvent {
  path: string;
}

export interface ContextMenuEvent {
  token: string;
  item: string;
}

export interface WindowStateEvent {
  fullscreen: boolean;
}

export interface EventMap {
  "documents-opened": Record<string, never>;
  "document-changed": DocumentChangedEvent;
  "document-removed": DocumentRemovedEvent;
  "menu-action": MenuActionEvent;
  "settings-changed": Settings;
  "themes-changed": CustomTheme[];
  "recents-changed": RecentItem[];
  "context-menu": ContextMenuEvent;
  "window-state": WindowStateEvent;
}
