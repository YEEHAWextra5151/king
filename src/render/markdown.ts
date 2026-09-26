import markdownit, { type MarkdownIt, type Token } from "markdown-it";
import footnote from "markdown-it-footnote";
import { full as emoji } from "markdown-it-emoji";
import alerts from "markdown-it-github-alerts";
import { escapeHtml } from "./hash";
import { anchors } from "./plugins/anchors";
import { fences, type CodeHooks } from "./plugins/fences";
import { frontMatter } from "./plugins/frontMatter";
import { images } from "./plugins/images";
import { gfmLinkify } from "./plugins/linkify";
import { math } from "./plugins/math";
import { lineAttrs, sourceLines } from "./plugins/sourceLines";
import { tables } from "./plugins/tables";
import { taskLists } from "./plugins/taskLists";
import type { DocumentStats, FrontMatter, Heading, PendingHighlight, RenderOptions } from "./types";

export type RenderHooks = CodeHooks;

/** Per-render state threaded through markdown-it's `env`. */
export interface RenderEnv {
  hooks: RenderHooks;
  frontMatterMode: RenderOptions["frontMatter"];
  headings?: Heading[];
  frontMatter?: FrontMatter;
  images?: string[];
  langs?: Set<string>;
  hasMath?: boolean;
  hasMermaid?: boolean;
  pending?: PendingHighlight[];
}

/** One configured markdown-it instance (CommonMark + GFM + extras). */
export function createMarkdown(): MarkdownIt {
  const md = markdownit({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
  });
  md.use(frontMatter)
    .use(footnote)
    .use(emoji)
    .use(alerts)
    .use(math)
    .use(taskLists)
    .use(tables)
    .use(gfmLinkify)
    .use(fences)
    .use(images)
    .use(anchors)
    .use(sourceLines);

  // Alerts: keep the plugin's parsing, but carry source lines and escape
  // the title.
  md.renderer.rules.alert_open = (tokens: Token[], idx: number) => {
    const t = tokens[idx];
    const { title, type, icon } = t.meta as { title: string; type: string; icon: string };
    return `<div class="markdown-alert markdown-alert-${escapeHtml(type)}"${lineAttrs(t.map)} role="note"><p class="markdown-alert-title">${icon}${escapeHtml(title)}</p>\n`;
  };

  // Accessible footnote section heading, like GitHub's.
  const footnoteOpen = md.renderer.rules.footnote_block_open;
  md.renderer.rules.footnote_block_open = (tokens, idx, options, env, self) =>
    (footnoteOpen?.(tokens, idx, options, env, self) ?? "").replace(
      '<section class="footnotes">',
      '<section class="footnotes" data-footnotes><h2 class="sr-only">Footnotes</h2>',
    );

  return md;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Word count over prose (code blocks excluded), for the status bar. */
export function documentStats(tokens: Token[], text: string): DocumentStats {
  let words = 0;
  for (const t of tokens) {
    if (t.type !== "inline") continue;
    for (const c of t.children ?? []) {
      if (c.type === "text" || c.type === "code_inline") {
        words += c.content.match(WORD)?.length ?? 0;
      }
    }
  }
  const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return { words, lines };
}
