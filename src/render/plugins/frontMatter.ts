import type { MarkdownIt, StateBlock } from "markdown-it";
import { escapeHtml } from "../hash";
import type { FrontMatter } from "../types";

/**
 * YAML (`---`) and TOML (`+++`) front matter at the very top of a file.
 * Always consumed by the parser; hidden by default, or shown as a compact
 * metadata card.
 */
export function frontMatter(md: MarkdownIt): void {
  md.block.ruler.before("table", "front_matter", frontMatterRule, { alt: [] });

  md.renderer.rules.front_matter = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const fm = token.meta as FrontMatter;
    const e = env as { frontMatter?: FrontMatter; frontMatterMode?: string };
    e.frontMatter = fm;
    if (e.frontMatterMode !== "card" || fm.entries.length === 0) return "";
    const rows = fm.entries
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
      .join("");
    return `<div class="front-matter" data-source-line="${fm.lines[0]}" data-source-line-end="${fm.lines[1]}"><dl>${rows}</dl></div>\n`;
  };
}

function frontMatterRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.blkIndent !== 0 || state.tShift[0] !== 0) return false;
  const lineText = (n: number) => state.src.slice(state.bMarks[n], state.eMarks[n]);
  const first = lineText(0).trimEnd();
  const fence = first === "---" ? "---" : first === "+++" ? "+++" : null;
  if (!fence) return false;
  let closing = -1;
  for (let n = 1; n < endLine; n++) {
    const text = lineText(n).trimEnd();
    if (text === fence || (fence === "---" && text === "...")) {
      closing = n;
      break;
    }
  }
  // `---` followed by nothing that closes is a thematic break, not front matter.
  if (closing < 0) return false;
  if (silent) return true;

  const raw = state.getLines(1, closing, 0, false).replace(/\n$/, "");
  const kind = fence === "---" ? "yaml" : "toml";
  const token = state.push("front_matter", "", 0);
  token.block = true;
  token.hidden = false;
  token.map = [0, closing + 1];
  token.markup = fence;
  token.content = raw;
  token.meta = {
    kind,
    raw,
    entries: parseEntries(raw, kind),
    lines: [0, closing + 1],
  } satisfies FrontMatter;
  state.line = closing + 1;
  return true;
}

/**
 * A deliberately small reader for the card: top-level `key: value` (YAML)
 * or `key = value` (TOML) pairs, with YAML block lists joined by commas.
 * Anything more complex is shown as its raw first line.
 */
export function parseEntries(raw: string, kind: "yaml" | "toml"): [string, string][] {
  const out: [string, string][] = [];
  const lines = raw.split("\n");
  const unquote = (v: string) => {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  if (kind === "yaml") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^([A-Za-z0-9_][\w .-]*?)\s*:(?:\s+(.*))?$/.exec(lines[i]);
      if (!m) continue;
      let value = (m[2] ?? "").trim();
      if (value === "" || value === "|" || value === ">") {
        const items: string[] = [];
        while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
          i++;
          const item = /^\s*-\s+(.*)$/.exec(lines[i]);
          items.push(unquote(item ? item[1] : lines[i]));
        }
        value = items.join(value === "" ? ", " : " ");
      } else if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map(unquote)
          .filter(Boolean)
          .join(", ");
      } else {
        value = unquote(value.replace(/\s+#.*$/, ""));
      }
      out.push([m[1], value]);
    }
  } else {
    let table = "";
    for (const line of lines) {
      const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (section) {
        table = section[1].trim() + ".";
        continue;
      }
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2].trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value.slice(1, -1).split(",").map(unquote).filter(Boolean).join(", ");
      } else {
        value = unquote(value.replace(/\s+#.*$/, ""));
      }
      out.push([table + m[1], value]);
    }
  }
  return out;
}
