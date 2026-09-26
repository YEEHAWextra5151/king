import type { MarkdownIt } from "markdown-it";

/**
 * GFM autolinks: `https://…`, `www.…` and e-mail addresses, but not bare
 * domains like `example.com`. linkify-it 6 (markdown-it 15) no longer links
 * `www.` by default, so fuzzy links are enabled and filtered back down.
 */
export function gfmLinkify(md: MarkdownIt): void {
  md.linkify.set({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: false });
  const match = md.linkify.match.bind(md.linkify);
  md.linkify.match = (text: string) => {
    const found = match(text);
    if (!found) return found;
    return found.filter((m) => m.schema !== "" || /^www\./i.test(m.raw));
  };
}
