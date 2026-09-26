/**
 * Shiki, in the render worker. Grammars are loaded per language, only for
 * fences a document uses, on the JavaScript regex engine (no WASM, so no
 * CSP relaxation). Colors are CSS variables (`var(--shiki-token-keyword)`),
 * so light/dark and theme switches never need a re-render.
 *
 * This module is the cheap half (language names, plain rendering); the
 * highlighter itself lives in shikiCore.ts and is imported on first use.
 */
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { escapeHtml } from "./hash";

type ShikiCore = typeof import("./shikiCore");

const THEME = "folio";

const aliases = new Map<string, string>();
const names = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  aliases.set(info.id, info.id);
  names.set(info.id, info.name);
  for (const alias of info.aliases ?? []) aliases.set(alias, info.id);
}
// Common fence names Shiki doesn't alias.
for (const [alias, id] of [
  ["console", "shellsession"],
  ["terminal", "shellsession"],
  ["js", "javascript"],
  ["node", "javascript"],
  ["golang", "go"],
  ["patch", "diff"],
  ["dockerfile", "docker"],
  ["jsonl", "json"],
  ["objective-c", "objc"],
] as const) {
  if (!aliases.has(alias) && aliases.has(id)) aliases.set(alias, id);
}

/** Languages that are displayed as plain text. */
const PLAIN = new Set(["", "text", "txt", "plain", "plaintext", "none", "nohighlight", "output"]);

/** Blocks larger than this aren't highlighted (tokenizing is superlinear). */
export const MAX_HIGHLIGHT_CHARS = 150_000;

let shiki: ShikiCore | null = null;
let shikiLoading: Promise<ShikiCore> | null = null;
const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

function loadCore(): Promise<ShikiCore> {
  shikiLoading ??= import("./shikiCore").then(async (mod) => {
    await mod.cacheReady;
    shiki = mod;
    return mod;
  });
  return shikiLoading;
}

/** Call after a batch of highlighting, so new regex translations are kept. */
export function highlighted(): void {
  shiki?.persist();
}

/** Canonical Shiki id for a fence name, or null for plain text/unknown. */
export function resolveLang(lang: string): string | null {
  const key = lang.trim().toLowerCase();
  if (PLAIN.has(key)) return null;
  return aliases.get(key) ?? null;
}

/** A human label for the code block header ("TypeScript", or the raw name). */
export function displayName(lang: string): string | null {
  const id = resolveLang(lang);
  if (id) return names.get(id) ?? id;
  const key = lang.trim();
  return key && !PLAIN.has(key.toLowerCase()) ? key : null;
}

export function isLoaded(id: string): boolean {
  return loaded.has(id);
}

export function ensureLangs(ids: string[]): Promise<void> {
  const tasks = ids.map((id) => {
    if (loaded.has(id)) return Promise.resolve();
    let task = loading.get(id);
    if (!task) {
      const importer = (bundledLanguages as Record<string, () => Promise<unknown>>)[id];
      task = importer
        ? Promise.all([importer(), loadCore()])
            .then(([mod, core]) => core.loadLanguage((mod as { default: never }).default))
            .then(() => {
              loaded.add(id);
            })
            .catch((err: unknown) => {
              console.warn(`Couldn't load grammar ${id}`, err);
            })
            .finally(() => loading.delete(id))
        : Promise.resolve();
      loading.set(id, task);
    }
    return task;
  });
  return Promise.all(tasks).then(() => undefined);
}

/** Highlights `code` with a loaded grammar. Throws if tokenizing fails. */
export function highlight(code: string, id: string): string {
  if (!shiki) throw new Error("Shiki isn't loaded");
  return shiki.highlight(code, id);
}

/** Same box as Shiki's output, so swapping in colors never shifts layout. */
export function plain(code: string): string {
  return `<pre class="shiki ${THEME} plain" tabindex="0"><code>${escapeHtml(code)}</code></pre>`;
}
