import type { MarkdownIt } from "markdown-it";

/**
 * Tables scroll horizontally inside their own container, and column
 * alignment uses `align` (like GitHub) instead of inline styles, which the
 * sanitizer strips from document HTML.
 */
export function tables(md: MarkdownIt): void {
  md.core.ruler.push("table_align", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "th_open" && token.type !== "td_open") continue;
      const style = token.attrGet("style");
      if (!style) continue;
      const m = /text-align:\s*(left|center|right)/.exec(style);
      token.attrs = (token.attrs ?? []).filter(([name]) => name !== "style");
      if (m) token.attrSet("align", m[1]);
    }
  });

  const open = md.renderer.rules.table_open;
  const close = md.renderer.rules.table_close;
  md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
    `<div class="table-wrap">` +
    (open ? open(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options));
  md.renderer.rules.table_close = (tokens, idx, options, env, self) =>
    (close ? close(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)) +
    `</div>\n`;
}
