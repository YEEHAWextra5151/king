import type { MarkdownIt, Token } from "markdown-it";
import { escapeHtml, hash } from "../hash";
import { lineAttrs } from "./sourceLines";

export interface CodeHooks {
  /** Returns the code block body (a trusted slot placeholder) and its key. */
  code(code: string, lang: string): { slot: string; key: string };
  math(tex: string, display: boolean): string;
}

/**
 * Fenced and indented code: Mermaid diagrams (rendered later on the main
 * thread, near the viewport), `math` fences, and highlighted code.
 */
export function fences(md: MarkdownIt): void {
  const unescape = md.utils.unescapeAll;

  md.core.ruler.push("fence_detect", (state) => {
    const env = state.env as { langs?: Set<string>; hasMermaid?: boolean };
    env.langs ??= new Set();
    for (const t of state.tokens) {
      if (t.type !== "fence") continue;
      const lang = fenceLang(t, unescape);
      if (lang === "mermaid") env.hasMermaid = true;
      else if (lang && lang !== "math") env.langs.add(lang);
    }
  });

  md.renderer.rules.fence = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const lang = fenceLang(token, unescape);
    return renderCode(token, token.content, lang, env as { hooks: CodeHooks });
  };

  md.renderer.rules.code_block = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    return renderCode(token, token.content, "", env as { hooks: CodeHooks });
  };
}

function fenceLang(token: Token, unescape: (s: string) => string): string {
  const info = token.info ? unescape(token.info).trim() : "";
  // GitHub accepts ```ts, ```ts title=x, and ```{.ts}.
  const first = info.split(/[\s{},]+/).find(Boolean) ?? "";
  return first.replace(/^\./, "").toLowerCase();
}

function renderCode(token: Token, content: string, lang: string, env: { hooks: CodeHooks }): string {
  const lines = lineAttrs(token.map);
  if (lang === "mermaid") {
    return `<div class="mermaid-block"${lines} data-mermaid="${hash(content)}"><pre class="mermaid-source">${escapeHtml(content)}</pre></div>\n`;
  }
  if (lang === "math") {
    return `<div class="math-block"${lines}>${env.hooks.math(content, true)}</div>\n`;
  }
  const { slot, key } = env.hooks.code(content, lang);
  return `<div class="code-block"${lines} data-lang="${escapeHtml(lang)}" data-hl="${key}">${slot}</div>\n`;
}
