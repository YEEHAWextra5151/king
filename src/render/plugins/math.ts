/*
 * Math syntax: `$…$`, `$$…$$` (inline or block) and ```` ```math ```` fences.
 *
 * The parsing rules are adapted from VS Code's @vscode/markdown-it-katex
 * (MIT, Copyright (c) Microsoft Corporation), which in turn follows
 * markdown-it-katex (MIT, Waylan Limberg). Rendering is delegated to a hook
 * so KaTeX itself is only loaded for documents that contain math.
 */
import type { MarkdownIt, StateBlock, StateInline } from "markdown-it";
import { lineAttrs } from "./sourceLines";

export interface MathHooks {
  math(tex: string, display: boolean): string;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /^\s$/u.test(ch);
}

function isWordCharacterOrNumber(ch: string | undefined): boolean {
  return ch !== undefined && /^[\w\d]$/u.test(ch);
}

function inlineDelim(state: StateInline, pos: number) {
  const prev = state.src[pos - 1];
  const next = state.src[pos + 1];
  const canOpen =
    prev !== "$" && prev !== "\\" && (prev === undefined || isWhitespace(prev) || !isWordCharacterOrNumber(prev));
  const canClose = next !== "$" && (next === undefined || isWhitespace(next) || !isWordCharacterOrNumber(next));
  return { canOpen, canClose };
}

function blockDelim(state: StateInline, pos: number) {
  const prev = state.src[pos - 1];
  const next = state.src[pos + 1];
  const after = state.src[pos + 2];
  const ok = state.src[pos] === "$" && prev !== "$" && prev !== "\\" && next === "$" && after !== "$";
  return { canOpen: ok, canClose: ok };
}

/** Finds the next unescaped `delim` at or after `from`. */
function findClosing(src: string, delim: string, from: number): number {
  let match = from;
  while ((match = src.indexOf(delim, match)) !== -1) {
    let pos = match - 1;
    while (src[pos] === "\\") pos -= 1;
    if ((match - pos) % 2 === 1) return match;
    match += delim.length;
  }
  return -1;
}

function inlineMath(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== "$") return false;
  const last = state.tokens.at(-1);
  // Inside inline HTML such as <span title="$5">: leave it alone.
  if (last?.type === "html_inline" && /^<\w+.+[^/]>$/.test(last.content)) return false;

  const open = inlineDelim(state, state.pos);
  if (!open.canOpen) {
    if (!silent) state.pending += "$";
    state.pos += 1;
    return true;
  }
  const start = state.pos + 1;
  const match = findClosing(state.src, "$", start);
  if (match === -1) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }
  if (match === start) {
    if (!silent) state.pending += "$$";
    state.pos = start + 1;
    return true;
  }
  if (!inlineDelim(state, match).canClose) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    token.content = state.src.slice(start, match);
  }
  state.pos = match + 1;
  return true;
}

function inlineMathBlock(state: StateInline, silent: boolean): boolean {
  if (state.src.slice(state.pos, state.pos + 2) !== "$$") return false;
  if (!blockDelim(state, state.pos).canOpen) {
    if (!silent) state.pending += "$$";
    state.pos += 2;
    return true;
  }
  const start = state.pos + 2;
  const match = findClosing(state.src, "$$", start);
  if (match === -1) {
    if (!silent) state.pending += "$$";
    state.pos = start;
    return true;
  }
  if (match === start) {
    if (!silent) state.pending += "$$$$";
    state.pos = start + 2;
    return true;
  }
  if (!blockDelim(state, match).canClose) {
    if (!silent) state.pending += "$$";
    state.pos = start;
    return true;
  }
  if (!silent) {
    const token = state.push("math_inline_block", "math", 0);
    token.markup = "$$";
    token.content = state.src.slice(start, match);
  }
  state.pos = match + 2;
  return true;
}

function blockMath(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  let pos = state.bMarks[start] + state.tShift[start];
  let max = state.eMarks[start];
  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== "$$") return false;
  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let found = false;
  const ends = [...firstLine.matchAll(/\$\$/g)];
  if (ends.length === 1 && ends[0].index === firstLine.trimEnd().length - 2) {
    // `$$x$$` on one line is a block.
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  } else if (ends.length > 1) {
    return false;
  }
  if (silent) return true;

  let next = start;
  let lastLine: string | undefined;
  while (!found) {
    next++;
    if (next >= end) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    // A less-indented non-empty line ends a list item.
    if (pos < max && state.tShift[next] < state.blkIndent) break;
    const line = state.src.slice(pos, max);
    if (line.trim().endsWith("$$")) {
      const lastPos = state.src.slice(0, max).lastIndexOf("$$");
      lastLine = state.src.slice(pos, lastPos);
      found = true;
    }
  }
  state.line = next + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content =
    (firstLine && firstLine.trim() ? firstLine + "\n" : "") +
    state.getLines(start + 1, next, state.tShift[start], true) +
    (lastLine && lastLine.trim() ? lastLine : "");
  token.map = [start, state.line];
  token.markup = "$$";
  return true;
}

export function math(md: MarkdownIt): void {
  md.inline.ruler.after("escape", "math_inline", inlineMath);
  md.inline.ruler.after("escape", "math_inline_block", inlineMathBlock);
  md.block.ruler.after("blockquote", "math_block", blockMath, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

  md.core.ruler.push("math_detect", (state) => {
    const env = state.env as { hasMath?: boolean };
    for (const t of state.tokens) {
      if (t.type === "math_block") env.hasMath = true;
      if (t.type === "fence" && t.info.trim().toLowerCase() === "math") env.hasMath = true;
      if (t.type === "inline" && t.children?.some((c) => c.type.startsWith("math_"))) env.hasMath = true;
      if (env.hasMath) return;
    }
  });

  const hooks = (env: unknown) => (env as { hooks: MathHooks }).hooks;
  md.renderer.rules.math_inline = (tokens, idx, _o, env) => {
    let tex = tokens[idx].content;
    // GitHub's $`…`$ form.
    if (tex.length > 2 && tex.startsWith("`") && tex.endsWith("`")) tex = tex.slice(1, -1);
    return `<span class="math-inline">${hooks(env).math(tex, false)}</span>`;
  };
  md.renderer.rules.math_inline_block = (tokens, idx, _o, env) =>
    `<span class="math-display">${hooks(env).math(tokens[idx].content, true)}</span>`;
  md.renderer.rules.math_block = (tokens, idx, _o, env) =>
    `<div class="math-block"${lineAttrs(tokens[idx].map)}>${hooks(env).math(tokens[idx].content, true)}</div>\n`;
}
