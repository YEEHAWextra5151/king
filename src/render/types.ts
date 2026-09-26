/** Types shared by the render worker and the main thread. */

export interface Heading {
  level: number;
  /** Display text (emoji as characters). */
  text: string;
  /** GitHub-compatible anchor (github-slugger), before the `user-content-` prefix. */
  id: string;
  /** 0-based source line. */
  line: number;
}

export interface FrontMatter {
  kind: "yaml" | "toml";
  raw: string;
  /** Top-level key/value pairs for the metadata card. */
  entries: [string, string][];
  /** Lines covered, including fences (0-based, end exclusive). */
  lines: [number, number];
}

export interface RenderOptions {
  frontMatter: "hidden" | "card";
}

export interface PendingHighlight {
  key: string;
  lang: string;
  code: string;
}

export interface DocumentStats {
  words: number;
  lines: number;
}

export interface RenderOutput {
  /** Untrusted HTML (goes through DOMPurify). */
  html: string;
  /**
   * Trusted HTML produced by Shiki/KaTeX, keyed by content hash and
   * referenced from the untrusted HTML as `<folio-slot data-k="nonce:key">`.
   */
  slots: Record<string, string>;
  /** Per-render random token the document can't guess. */
  nonce: string;
  headings: Heading[];
  frontMatter: FrontMatter | null;
  /** Local and remote image sources referenced by the document. */
  images: string[];
  /** Code blocks rendered plain because their grammar wasn't loaded yet. */
  pending: PendingHighlight[];
  hasMermaid: boolean;
  hasMath: boolean;
  stats: DocumentStats;
  timings: { parse: number; render: number; total: number };
}

export type WorkerRequest =
  | { type: "render"; id: number; key: string; text: string; options: RenderOptions }
  | { type: "warm"; langs: string[] };

export type WorkerResponse =
  | { type: "rendered"; id: number; key: string; output: RenderOutput }
  | { type: "highlighted"; id: number; key: string; blocks: { key: string; html: string }[] }
  | { type: "error"; id: number; key: string; message: string };
