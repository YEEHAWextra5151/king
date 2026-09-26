/**
 * Find in the rendered document. Matches are painted with the CSS Custom
 * Highlight API (no DOM changes), falling back to <mark> elements where the
 * API is missing.
 */

export interface FindResult {
  total: number;
  /** 0-based index of the current match, or -1. */
  current: number;
}

export interface FindTarget {
  search(query: string, fromTop?: boolean): FindResult;
  next(): FindResult;
  previous(): FindResult;
  clear(): void;
}

const MAX_MATCHES = 5000;
const SKIP = ".code-header, .mermaid-source, .sr-only, .katex-mathml, script, style";

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

const highlights: HighlightRegistry | undefined = (globalThis.CSS as unknown as { highlights?: HighlightRegistry })
  ?.highlights;
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
const supportsHighlights = !!highlights && !!HighlightCtor;

export class DomFinder implements FindTarget {
  private ranges: Range[] = [];
  private marks: HTMLElement[] = [];
  private current = -1;

  constructor(
    private readonly root: HTMLElement,
    private readonly scroller: HTMLElement,
  ) {}

  search(query: string, fromTop = false): FindResult {
    this.clear();
    if (!query) return { total: 0, current: -1 };
    const needle = query.toLocaleLowerCase();
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    // Concatenate text nodes so matches can span inline elements.
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      starts.push(text.length);
      text += (n as Text).data;
    }
    const haystack = text.toLocaleLowerCase();
    const locate = (offset: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { node: nodes[lo], offset: offset - starts[lo] };
    };
    let from = 0;
    while (this.ranges.length < MAX_MATCHES) {
      const i = haystack.indexOf(needle, from);
      if (i < 0) break;
      const start = locate(i);
      const end = locate(i + needle.length - 1);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      this.ranges.push(range);
      from = i + Math.max(needle.length, 1);
    }
    if (this.ranges.length === 0) return { total: 0, current: -1 };
    // Start at the first match at or below the top of the viewport.
    const top = this.scroller.getBoundingClientRect().top;
    this.current = fromTop ? 0 : Math.max(0, this.ranges.findIndex((r) => r.getBoundingClientRect().top >= top));
    this.paint();
    this.reveal();
    return this.result();
  }

  next(): FindResult {
    if (!this.ranges.length) return this.result();
    this.current = (this.current + 1) % this.ranges.length;
    this.paint();
    this.reveal();
    return this.result();
  }

  previous(): FindResult {
    if (!this.ranges.length) return this.result();
    this.current = (this.current - 1 + this.ranges.length) % this.ranges.length;
    this.paint();
    this.reveal();
    return this.result();
  }

  clear(): void {
    if (supportsHighlights) {
      highlights!.delete("folio-find");
      highlights!.delete("folio-find-current");
    }
    for (const mark of this.marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
    this.marks = [];
    this.ranges = [];
    this.current = -1;
  }

  private result(): FindResult {
    return { total: this.ranges.length, current: this.current };
  }

  private paint() {
    if (supportsHighlights) {
      const others = this.ranges.filter((_, i) => i !== this.current);
      highlights!.set("folio-find", new HighlightCtor!(...others));
      const cur = this.ranges[this.current];
      if (cur) highlights!.set("folio-find-current", new HighlightCtor!(cur));
      else highlights!.delete("folio-find-current");
      return;
    }
    // Fallback: wrap each match once, then move the "current" class.
    if (this.marks.length === 0) {
      // Wrap from the end so earlier ranges stay valid.
      const wrapped: HTMLElement[] = [];
      for (let i = this.ranges.length - 1; i >= 0; i--) {
        const r = this.ranges[i];
        if (r.startContainer !== r.endContainer) continue; // spans elements: skip in fallback
        const mark = document.createElement("mark");
        mark.className = "folio-find";
        try {
          r.surroundContents(mark);
          wrapped.unshift(mark);
        } catch {
          /* ignore */
        }
      }
      this.marks = wrapped;
      this.ranges = wrapped.map((m) => {
        const r = document.createRange();
        r.selectNodeContents(m);
        return r;
      });
      this.current = Math.min(this.current, this.ranges.length - 1);
    }
    this.marks.forEach((m, i) => m.classList.toggle("current", i === this.current));
  }

  private reveal() {
    const range = this.ranges[this.current];
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const box = this.scroller.getBoundingClientRect();
    if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) {
      this.scroller.scrollTop += rect.top - box.top - box.height / 3;
    }
    // Horizontally scrolled containers (tables, code) too.
    const container = range.startContainer.parentElement?.closest(".table-wrap, pre, .math-block");
    if (container instanceof HTMLElement) {
      const c = container.getBoundingClientRect();
      if (rect.left < c.left || rect.right > c.right) container.scrollLeft += rect.left - c.left - c.width / 3;
    }
  }
}
