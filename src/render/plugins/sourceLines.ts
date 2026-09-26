import type { MarkdownIt } from "markdown-it";

/**
 * Tags block tokens with the source lines they came from, the approach VS
 * Code's preview uses. `data-source-line` / `data-source-line-end` drive
 * scroll sync, reading-position restore, live-reload anchoring and
 * double-click-to-source. Raw HTML blocks can't carry attributes.
 */
export function sourceLines(md: MarkdownIt): void {
  md.core.ruler.push("source_lines", (state) => {
    for (const token of state.tokens) {
      if (!token.map || !token.block || token.nesting < 0) continue;
      if (token.type === "html_block" || token.type === "front_matter") continue;
      token.attrSet("data-source-line", String(token.map[0]));
      token.attrSet("data-source-line-end", String(token.map[1]));
    }
  });
}

/** Attribute string for renderers that build their own opening tag. */
export function lineAttrs(map: [number, number] | null | undefined): string {
  if (!map) return "";
  return ` data-source-line="${map[0]}" data-source-line-end="${map[1]}"`;
}
