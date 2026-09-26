/**
 * Shiki's highlighter and JavaScript regex engine: loaded on demand by
 * highlight.ts the first time a grammar is needed, so neither is on the
 * worker's startup path (code blocks render plain first, then get colors).
 */
import { createCssVariablesTheme, createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export const THEME = "folio";

const theme = createCssVariablesTheme({
  name: THEME,
  variablePrefix: "--shiki-",
  variableDefaults: {},
  fontStyle: true,
});

let highlighter: HighlighterCore | null = null;

function core(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [theme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

export function loadLanguage(grammar: never): Promise<void> {
  return core().loadLanguage(grammar);
}

export function highlight(code: string, id: string): string {
  return core().codeToHtml(code, { lang: id, theme: THEME });
}
