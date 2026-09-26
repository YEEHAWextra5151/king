import type { MarkdownIt } from "markdown-it";

const IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SRCSET = /<source\b[^>]*?\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** Candidate URLs in a `srcset` value. */
export function srcsetUrls(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * Collects every image a document references (Markdown images, raw HTML
 * `<img src>` and `<picture><source srcset>`), so the main thread can grant
 * local ones to the asset protocol before the HTML is inserted.
 */
export function images(md: MarkdownIt): void {
  md.core.ruler.push("collect_images", (state) => {
    const env = state.env as { images?: string[] };
    const found = new Set<string>(env.images ?? []);
    const scanHtml = (html: string) => {
      for (const m of html.matchAll(IMG_SRC)) found.add(m[1] ?? m[2] ?? m[3]);
      for (const m of html.matchAll(SRCSET)) {
        for (const url of srcsetUrls(m[1] ?? m[2] ?? m[3])) found.add(url);
      }
    };
    for (const t of state.tokens) {
      if (t.type === "html_block") scanHtml(t.content);
      for (const c of t.children ?? []) {
        if (c.type === "image") {
          const src = c.attrGet("src");
          if (src) found.add(String(src));
        } else if (c.type === "html_inline") {
          scanHtml(c.content);
        }
      }
    }
    env.images = [...found];
  });

  // Images load eagerly (lazy loading would shift content above a restored
  // reading position); decoding stays off the main thread.
  const image = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("decoding", "async");
    return image(tokens, idx, options, env, self);
  };
}
