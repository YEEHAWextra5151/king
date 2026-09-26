/**
 * Document rendering, independent of the worker plumbing so it can be unit
 * tested in Node. Parse once, load what the document needs (KaTeX only if
 * it has math), render, and report code blocks whose grammar still has to
 * be loaded so colors can be patched in afterwards.
 */
import type { MarkdownIt } from "markdown-it";
import { escapeHtml, hash, Lru } from "./hash";
import * as hl from "./highlight";
import { createMarkdown, documentStats, type RenderEnv } from "./markdown";
import type { PendingHighlight, RenderOptions, RenderOutput } from "./types";

type Katex = typeof import("katex").default;

let md: MarkdownIt | null = null;
let katex: Katex | null = null;
const codeCache = new Lru<string, string>(2000);
const mathCache = new Lru<string, string>(4000);

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5.5 2.5h6a1.5 1.5 0 0 1 1.5 1.5v6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="3" y="5" width="7.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

function nonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function codeHeader(label: string | null): string {
  const name = label ? `<span class="code-lang">${escapeHtml(label)}</span>` : `<span class="code-lang"></span>`;
  return `<div class="code-header">${name}<button type="button" class="code-copy" aria-label="Copy code" title="Copy">${COPY_ICON}</button></div>`;
}

function mathError(tex: string, display: boolean, message: string): string {
  const body = `<span class="render-error-message">${escapeHtml(message)}</span><code class="render-error-source">${escapeHtml(tex)}</code>`;
  return display
    ? `<div class="render-error math-error" role="note">${body}</div>`
    : `<span class="render-error math-error" role="note" title="${escapeHtml(message)}"><code>${escapeHtml(tex)}</code></span>`;
}

export async function loadKatex(): Promise<void> {
  if (!katex) katex = (await import("katex")).default;
}

export interface RenderResult {
  output: RenderOutput;
  /** Resolves when the grammars for `output.pending` are loaded. */
  grammars: Promise<void> | null;
}

export async function renderDocument(text: string, options: RenderOptions): Promise<RenderResult> {
  const t0 = performance.now();
  md ??= createMarkdown();
  const key = nonce();
  const slots: Record<string, string> = {};
  const pending: PendingHighlight[] = [];
  const slot = (contentKey: string, html: string) => {
    slots[contentKey] = html;
    return `<folio-slot data-k="${key}:${contentKey}"></folio-slot>`;
  };

  const env: RenderEnv = {
    frontMatterMode: options.frontMatter,
    pending,
    hooks: {
      code(content, lang) {
        const body = content.endsWith("\n") ? content.slice(0, -1) : content;
        const id = hl.resolveLang(lang);
        const contentKey = "c" + hash((id ?? lang) + "\u0000" + body);
        let inner = codeCache.get(contentKey);
        if (!inner) {
          if (id && hl.isLoaded(id) && body.length <= hl.MAX_HIGHLIGHT_CHARS) {
            try {
              inner = hl.highlight(body, id);
            } catch (err) {
              console.warn("highlight failed", err);
              inner = hl.plain(body);
            }
            codeCache.set(contentKey, inner);
          } else {
            inner = hl.plain(body);
            if (id && body.length <= hl.MAX_HIGHLIGHT_CHARS) {
              pending.push({ key: contentKey, lang: id, code: body });
            } else {
              codeCache.set(contentKey, inner);
            }
          }
        }
        return { slot: slot(contentKey, codeHeader(hl.displayName(lang)) + inner), key: contentKey };
      },
      math(tex, display) {
        const contentKey = (display ? "d" : "i") + hash(tex);
        let html = mathCache.get(contentKey);
        if (!html) {
          if (!katex) {
            html = mathError(tex, display, "Math rendering is unavailable.");
          } else {
            try {
              html = katex.renderToString(tex, {
                displayMode: display,
                throwOnError: true,
                output: "htmlAndMathml",
                strict: "ignore",
                trust: false,
                maxSize: 50,
                maxExpand: 1000,
              });
            } catch (err) {
              html = mathError(tex, display, err instanceof Error ? err.message : String(err));
            }
          }
          mathCache.set(contentKey, html);
        }
        return slot(contentKey, html);
      },
    },
  };

  const tokens = md.parse(text, env);
  const t1 = performance.now();

  if (env.hasMath) await loadKatex();

  const needed = [...(env.langs ?? [])]
    .map((l) => hl.resolveLang(l))
    .filter((id): id is string => !!id && !hl.isLoaded(id));
  const grammars = needed.length > 0 ? hl.ensureLangs([...new Set(needed)]) : null;

  const html = md.renderer.render(tokens, md.options, env);
  const t2 = performance.now();

  // Duplicate code blocks share a key; highlight each once.
  const uniquePending = [...new Map(pending.map((p) => [p.key, p])).values()];

  return {
    output: {
      html,
      slots,
      nonce: key,
      headings: env.headings ?? [],
      frontMatter: env.frontMatter ?? null,
      images: env.images ?? [],
      pending: uniquePending,
      hasMermaid: !!env.hasMermaid,
      hasMath: !!env.hasMath,
      stats: documentStats(tokens, text),
      timings: { parse: t1 - t0, render: t2 - t1, total: t2 - t0 },
    },
    grammars: uniquePending.length > 0 ? grammars : null,
  };
}

/** Highlights blocks that were rendered plain; returns their full slot HTML. */
export function highlightPending(pending: PendingHighlight[]): { key: string; html: string }[] {
  const out: { key: string; html: string }[] = [];
  for (const p of pending) {
    if (!hl.isLoaded(p.lang)) continue;
    let inner = codeCache.get(p.key);
    if (!inner) {
      try {
        inner = hl.highlight(p.code, p.lang);
      } catch (err) {
        console.warn("highlight failed", err);
        inner = hl.plain(p.code);
      }
      codeCache.set(p.key, inner);
    }
    out.push({ key: p.key, html: inner });
  }
  return out;
}

/** Loads grammars ahead of time (idle warm-up after the first document). */
export function warm(langs: string[]): Promise<void> {
  const ids = langs.map((l) => hl.resolveLang(l)).filter((id): id is string => !!id);
  return hl.ensureLangs(ids).then(() => {
    // Run each tokenizer once so the first real block is fast.
    for (const id of ids) {
      if (hl.isLoaded(id)) {
        try {
          hl.highlight("x", id);
        } catch {
          /* ignore */
        }
      }
    }
  });
}
