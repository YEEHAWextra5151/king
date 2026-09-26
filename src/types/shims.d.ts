declare module "markdown-it-footnote" {
  import type { MarkdownIt } from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-emoji" {
  import type { MarkdownIt } from "markdown-it";
  type EmojiPlugin = (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export const full: EmojiPlugin;
  export const light: EmojiPlugin;
  export const bare: EmojiPlugin;
}
