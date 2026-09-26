/**
 * Committing a render to the page, and mapping between scroll positions and
 * source lines.
 *
 * Top-level blocks are diffed by content hash: unchanged DOM nodes are kept
 * (images don't reload, diagrams don't re-render), changed ones are replaced
 * and, on live reload, briefly tinted.
 */

const blockHashes = new WeakMap<Element, string>();

export interface CommitResult {
  changed: Element[];
  initial: boolean;
}

export function commitBlocks(
  container: HTMLElement,
  fragment: DocumentFragment,
  hashes: string[],
  options: { tint: boolean },
): CommitResult {
  const incoming = Array.from(fragment.children);
  incoming.forEach((el, i) => blockHashes.set(el, hashes[i]));
  const existing = Array.from(container.children);
  if (existing.length === 0) {
    container.replaceChildren(fragment);
    return { changed: incoming, initial: true };
  }

  const pool = new Map<string, Element[]>();
  for (const el of existing) {
    const h = blockHashes.get(el);
    if (!h) continue;
    const list = pool.get(h);
    if (list) list.push(el);
    else pool.set(h, [el]);
  }

  const result: Element[] = [];
  const changed: Element[] = [];
  incoming.forEach((el, i) => {
    const reuse = pool.get(hashes[i])?.shift();
    if (reuse) {
      syncLines(reuse, el);
      result.push(reuse);
    } else {
      result.push(el);
      changed.push(el);
    }
  });

  const kept = new Set(result);
  for (const el of existing) if (!kept.has(el)) el.remove();

  let cursor = container.firstElementChild;
  for (const el of result) {
    if (el === cursor) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    container.insertBefore(el, cursor);
  }

  if (options.tint) {
    for (const el of changed) {
      el.classList.add("block-changed");
      el.addEventListener("animationend", () => el.classList.remove("block-changed"), { once: true });
    }
  }
  return { changed, initial: false };
}

/** Block hashes of a container's children (for caching a rendered tab). */
export function hashesOf(container: Element): string[] {
  return Array.from(container.children, (el) => blockHashes.get(el) ?? "");
}

/** Re-associates hashes with children restored from cached HTML. */
export function adoptHashes(container: Element, hashes: string[]) {
  Array.from(container.children).forEach((el, i) => {
    if (hashes[i]) blockHashes.set(el, hashes[i]);
  });
}

/** Copies source-line attributes from a fresh render onto a reused block. */
function syncLines(target: Element, source: Element) {
  const copy = (to: Element, from: Element) => {
    for (const name of ["data-source-line", "data-source-line-end"]) {
      const v = from.getAttribute(name);
      if (v !== null) to.setAttribute(name, v);
    }
  };
  copy(target, source);
  const to = target.querySelectorAll("[data-source-line]");
  const from = source.querySelectorAll("[data-source-line]");
  if (to.length === from.length) to.forEach((el, i) => copy(el, from[i]));
}

// ─── Source-line geometry ────────────────────────────────────────────────

export interface LineEntry {
  el: HTMLElement;
  line: number;
  end: number;
}

/** Elements carrying source lines, in document order (visible ones only). */
export function lineEntries(root: HTMLElement): LineEntry[] {
  const out: LineEntry[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-source-line]"))) {
    const line = Number(el.dataset.sourceLine);
    const end = Number(el.dataset.sourceLineEnd ?? line + 1);
    if (!Number.isFinite(line)) continue;
    // Skip content inside closed <details> and other hidden boxes.
    if (el.offsetParent === null && el.getClientRects().length === 0) continue;
    out.push({ el, line, end: Math.max(end, line + 1) });
  }
  return out;
}

/** Top of `el` in the scroll container's content coordinates. */
export function topOf(el: Element, scroller: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * The fractional source line at content offset `y`: the last block that
 * starts at or above `y`, interpolated within its height, so long code
 * blocks and tables stay aligned.
 */
export function lineAtOffset(entries: LineEntry[], scroller: HTMLElement, y: number): number {
  if (entries.length === 0) return 0;
  let lo = 0;
  let hi = entries.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topOf(entries[mid].el, scroller) <= y) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return entries[0].line;
  // Prefer the deepest element among those starting at the same place.
  const entry = entries[best];
  const top = topOf(entry.el, scroller);
  const height = entry.el.getBoundingClientRect().height || 1;
  const fraction = Math.min(Math.max((y - top) / height, 0), 1);
  const next = entries[best + 1];
  // Interpolate towards the next block's line when it starts within this one's span.
  const span = next && next.line > entry.line && next.line < entry.end ? next.line - entry.line : entry.end - entry.line;
  return entry.line + fraction * span;
}

/** Content offset at which fractional source `line` starts. */
export function offsetForLine(entries: LineEntry[], scroller: HTMLElement, line: number): number {
  if (entries.length === 0) return 0;
  let best: LineEntry | null = null;
  for (const e of entries) {
    if (e.line <= line) best = e;
    else break;
  }
  if (!best) return topOf(entries[0].el, scroller);
  const top = topOf(best.el, scroller);
  const height = best.el.getBoundingClientRect().height;
  const index = entries.indexOf(best);
  const next = entries[index + 1];
  const span = next && next.line > best.line && next.line < best.end ? next.line - best.line : best.end - best.line;
  const fraction = Math.min(Math.max((line - best.line) / span, 0), 1);
  return top + fraction * height;
}

/** The block element for a source line (for double-click and outline sync). */
export function elementForLine(entries: LineEntry[], line: number): HTMLElement | null {
  let best: LineEntry | null = null;
  for (const e of entries) {
    if (e.line <= line) best = e;
    else break;
  }
  return best?.el ?? null;
}
