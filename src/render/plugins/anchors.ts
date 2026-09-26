import GithubSlugger from "github-slugger";
import type { MarkdownIt, Token } from "markdown-it";
import type { Heading } from "../types";

/**
 * Heading ids that match GitHub's exactly, so README links like
 * `#installation` work. GitHub slugs the heading's text content with
 * github-slugger; emoji shortcodes count as their `:name:` text, which is
 * why `## :rocket: Setup` is `#rocket-setup` on GitHub.
 */
export function anchors(md: MarkdownIt): void {
  md.core.ruler.push("heading_anchors", (state) => {
    const slugger = new GithubSlugger();
    const headings: Heading[] = [];
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      if (open.type !== "heading_open") continue;
      const inline = tokens[i + 1];
      const children = inline?.children ?? [];
      const id = slugger.slug(slugText(children));
      open.attrSet("id", id);
      headings.push({
        level: Number(open.tag.slice(1)),
        text: displayText(children).trim(),
        id,
        line: open.map?.[0] ?? 0,
      });
    }
    (state.env as { headings?: Heading[] }).headings = headings;
  });
}

function slugText(children: Token[]): string {
  let out = "";
  for (const t of children) {
    switch (t.type) {
      case "text":
      case "code_inline":
      case "math_inline":
        out += t.content;
        break;
      case "emoji":
        out += `:${t.markup}:`;
        break;
      case "softbreak":
      case "hardbreak":
        out += " ";
        break;
      default:
        // Tags (links, emphasis, raw HTML) contribute no text; images
        // have no text content.
        break;
    }
  }
  return out;
}

function displayText(children: Token[]): string {
  let out = "";
  for (const t of children) {
    switch (t.type) {
      case "text":
      case "code_inline":
      case "emoji":
      case "math_inline":
        out += t.content;
        break;
      case "softbreak":
      case "hardbreak":
        out += " ";
        break;
      case "image":
        break;
      default:
        break;
    }
  }
  return out;
}
