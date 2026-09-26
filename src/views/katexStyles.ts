/** KaTeX's stylesheet (and fonts), loaded once, only for documents with math. */
let katexCss: Promise<unknown> | null = null;

export function loadKatexCss(): Promise<unknown> {
  katexCss ??= import("./katexCss");
  return katexCss;
}

/** Cheap guess, from the source, that a document has math worth prefetching for. */
export function mayHaveMath(text: string): boolean {
  return text.includes("$") || /^\s*(```|~~~)\s*math\b/m.test(text);
}
