import type { MarkdownIt, Token } from "markdown-it";

const TASK = /^\[([ xX])\][ \t ]/;

/**
 * GitHub task lists: `- [ ] todo` / `- [x] done`. Checkboxes are disabled
 * (Folio never modifies files) and drawn by CSS in the accent color.
 */
export function taskLists(md: MarkdownIt): void {
  md.core.ruler.after("inline", "task_lists", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== "inline") continue;
      if (tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
      const first = inline.children?.[0];
      if (!first || first.type !== "text") continue;
      const m = TASK.exec(first.content);
      if (!m) continue;
      const checked = m[1] !== " ";
      first.content = first.content.slice(m[0].length);
      inline.content = inline.content.slice(m[0].length);

      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? " checked" : ""} aria-label="${checked ? "Completed" : "Not completed"}"> `;
      inline.children!.unshift(box);

      const item = tokens[i - 2];
      item.attrJoin("class", "task-list-item");
      const list = findListOpen(tokens, i - 2);
      if (list && !String(list.attrGet("class") ?? "").includes("contains-task-list")) {
        list.attrJoin("class", "contains-task-list");
      }
    }
  });
}

function findListOpen(tokens: Token[], itemIndex: number): Token | null {
  const level = tokens[itemIndex].level - 1;
  for (let j = itemIndex - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.level === level && (t.type === "bullet_list_open" || t.type === "ordered_list_open")) return t;
  }
  return null;
}
