/**
 * The Code view: CodeMirror 6, read-only but navigable (cursor, keyboard
 * selection, find), with line numbers, soft wrap, folding by heading and
 * fenced code highlighted by language. Loaded lazily.
 *
 * The keymap is cut down to navigation and selection, so CodeMirror never
 * swallows a menu shortcut (⌘/, ⌘[, ⌘F…). The architecture keeps editing
 * one compartment away: `setEditable(true)` + an update listener would be
 * enough to turn it into an editor later.
 */
import { standardKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  foldGutter,
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { SearchCursor } from "@codemirror/search";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { FindResult, FindTarget } from "./find";

const EDITING_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Mod-Backspace",
  "Mod-Delete",
  "Alt-Backspace",
  "Alt-Delete",
  "Ctrl-d",
  "Ctrl-h",
  "Ctrl-k",
  "Ctrl-Alt-h",
  "Ctrl-o",
  "Ctrl-t",
]);

/** Navigation and selection only. */
const viewerKeymap = standardKeymap.filter(
  (binding) => !EDITING_KEYS.has(binding.key ?? "") && !EDITING_KEYS.has(binding.mac ?? ""),
);

/** The shared syntax palette (same CSS variables as Shiki). */
const folioHighlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self, t.tagName],
    color: "var(--syn-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.inserted, t.monospace], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name), t.standard(t.name), t.unit], color: "var(--syn-number)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.typeName, t.className, t.attributeName, t.namespace],
    color: "var(--syn-function)",
  },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.punctuation, t.bracket, t.separator, t.operator, t.derefOperator], color: "var(--syn-punctuation)" },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta, t.labelName], color: "var(--text-tertiary)" },
  { tag: t.heading, fontWeight: "600", color: "var(--text-heading)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--link)" },
  { tag: t.quote, color: "var(--text-secondary)" },
  { tag: t.deleted, color: "var(--danger-text)" },
  { tag: t.invalid, color: "var(--danger-text)" },
]);

// ─── Find decorations (our own find bar drives CodeMirror's search) ──────

const setFind = StateEffect.define<{ query: string; current: number } | null>();

const findField = StateField.define<{ decorations: DecorationSet; ranges: { from: number; to: number }[] }>({
  create: () => ({ decorations: Decoration.none, ranges: [] }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setFind)) continue;
      if (!effect.value || !effect.value.query) return { decorations: Decoration.none, ranges: [] };
      const { query, current } = effect.value;
      const ranges: { from: number; to: number }[] = [];
      const cursor = new SearchCursor(tr.state.doc, query, 0, tr.state.doc.length, (x) => x.toLowerCase());
      while (!cursor.next().done && ranges.length < 10000) ranges.push({ from: cursor.value.from, to: cursor.value.to });
      const builder = new RangeSetBuilder<Decoration>();
      ranges.forEach((r, i) =>
        builder.add(r.from, r.to, Decoration.mark({ class: i === current ? "cm-searchMatch cm-searchMatch-selected" : "cm-searchMatch" })),
      );
      return { decorations: builder.finish(), ranges };
    }
    return tr.docChanged ? { decorations: value.decorations.map(tr.changes), ranges: value.ranges } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

// ─── Controller ──────────────────────────────────────────────────────────

export interface CodeViewOptions {
  text: string;
  fileName: string;
  isMarkdown: boolean;
  softWrap: boolean;
  onScrollLine(line: number, byUser: boolean): void;
}

export class CodeViewController implements FindTarget {
  readonly view: EditorView;
  private wrap = new Compartment();
  private language = new Compartment();
  private editable = new Compartment();
  private programmaticUntil = 0;
  private frame = 0;
  private query = "";
  private current = -1;

  constructor(host: HTMLElement, private readonly options: CodeViewOptions) {
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter({ openText: "⌄", closedText: "›" }),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      EditorState.readOnly.of(true),
      this.editable.of(EditorView.editable.of(true)),
      EditorState.tabSize.of(4),
      this.wrap.of(options.softWrap ? EditorView.lineWrapping : []),
      syntaxHighlighting(folioHighlight),
      this.language.of([]),
      keymap.of(viewerKeymap),
      findField,
      EditorView.contentAttributes.of({
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        "aria-label": "Source",
        "aria-readonly": "true",
      }),
    ];
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: options.text, extensions }),
    });
    this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    void this.loadLanguage();
  }

  private async loadLanguage() {
    let support: LanguageSupport | null = null;
    if (this.options.isMarkdown) {
      support = markdown({ base: markdownLanguage, codeLanguages: languages });
    } else {
      const desc = LanguageDescription.matchFilename(languages, this.options.fileName);
      support = desc ? await desc.load().catch(() => null) : null;
    }
    if (support) this.view.dispatch({ effects: this.language.reconfigure(support) });
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.view.destroy();
  }

  /** Replaces the text with a minimal change, so position and selection hold. */
  setText(text: string) {
    const doc = this.view.state.doc.toString();
    if (doc === text) return;
    let start = 0;
    const max = Math.min(doc.length, text.length);
    while (start < max && doc.charCodeAt(start) === text.charCodeAt(start)) start++;
    let endOld = doc.length;
    let endNew = text.length;
    while (endOld > start && endNew > start && doc.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) {
      endOld--;
      endNew--;
    }
    this.view.dispatch({ changes: { from: start, to: endOld, insert: text.slice(start, endNew) } });
    if (this.query) this.search(this.query, false, true);
  }

  setSoftWrap(on: boolean) {
    const line = this.topLine();
    this.view.dispatch({ effects: this.wrap.reconfigure(on ? EditorView.lineWrapping : []) });
    requestAnimationFrame(() => this.scrollToLine(line));
  }

  /** Fractional 0-based source line at the top of the viewport. */
  topLine(): number {
    const view = this.view;
    const scrollTop = view.scrollDOM.getBoundingClientRect().top;
    const height = scrollTop - view.documentTop;
    const block = view.lineBlockAtHeight(Math.max(0, height));
    const number = view.state.doc.lineAt(block.from).number - 1;
    const fraction = block.height > 0 ? Math.min(Math.max((height - block.top) / block.height, 0), 1) : 0;
    return number + fraction;
  }

  scrollToLine(line: number, options: { select?: boolean; flash?: boolean } = {}) {
    const view = this.view;
    const doc = view.state.doc;
    const whole = Math.min(Math.max(Math.floor(line), 0), doc.lines - 1);
    const fraction = line - whole;
    const target = doc.line(whole + 1);
    const block = view.lineBlockAt(target.from);
    const docTopInScroll = view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
    this.programmaticUntil = performance.now() + 120;
    view.scrollDOM.scrollTop = Math.max(0, docTopInScroll + block.top + fraction * block.height);
    if (options.select) {
      view.dispatch({ selection: { anchor: target.from } });
    }
    if (options.flash) {
      requestAnimationFrame(() => {
        const dom = view.domAtPos(target.from).node;
        const lineEl = (dom instanceof HTMLElement ? dom : dom.parentElement)?.closest(".cm-line");
        if (lineEl) {
          lineEl.classList.remove("cm-highlight-line");
          void (lineEl as HTMLElement).offsetWidth;
          lineEl.classList.add("cm-highlight-line");
        }
      });
    }
  }

  /** Current cursor line (1-based), for Open in Editor. */
  cursorLine(): number {
    const head = this.view.state.selection.main.head;
    return this.view.state.doc.lineAt(head).number;
  }

  focus() {
    this.view.focus();
  }

  selectAll() {
    this.view.dispatch({ selection: { anchor: 0, head: this.view.state.doc.length } });
    this.view.focus();
  }

  selectedText(): string {
    const { from, to } = this.view.state.selection.main;
    return this.view.state.sliceDoc(from, to);
  }

  private onScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.options.onScrollLine(this.topLine(), performance.now() > this.programmaticUntil);
    });
  };

  // ─── FindTarget ────────────────────────────────────────────────────────

  search(query: string, fromTop = false, keepCurrent = false): FindResult {
    this.query = query;
    const view = this.view;
    view.dispatch({ effects: setFind.of(query ? { query, current: -1 } : null) });
    const ranges = view.state.field(findField).ranges;
    if (!ranges.length) {
      this.current = -1;
      return { total: 0, current: -1 };
    }
    if (!keepCurrent || this.current < 0 || this.current >= ranges.length) {
      const top = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.getBoundingClientRect().top - view.documentTop)).from;
      this.current = fromTop ? 0 : Math.max(0, ranges.findIndex((r) => r.from >= top));
    }
    return this.select();
  }

  next(): FindResult {
    const ranges = this.view.state.field(findField).ranges;
    if (!ranges.length) return { total: 0, current: -1 };
    this.current = (this.current + 1) % ranges.length;
    return this.select();
  }

  previous(): FindResult {
    const ranges = this.view.state.field(findField).ranges;
    if (!ranges.length) return { total: 0, current: -1 };
    this.current = (this.current - 1 + ranges.length) % ranges.length;
    return this.select();
  }

  clear() {
    this.query = "";
    this.current = -1;
    this.view.dispatch({ effects: setFind.of(null) });
  }

  private select(): FindResult {
    const view = this.view;
    view.dispatch({ effects: setFind.of({ query: this.query, current: this.current }) });
    const ranges = view.state.field(findField).ranges;
    const r = ranges[this.current];
    if (r) {
      view.dispatch({
        selection: { anchor: r.from, head: r.to },
        effects: EditorView.scrollIntoView(r.from, { y: "center" }),
      });
    }
    return { total: ranges.length, current: this.current };
  }
}
