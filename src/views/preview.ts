/**
 * The imperative document surface behind PreviewPane. React never touches
 * document content: renders are committed with a keyed block diff so live
 * reloads keep unchanged DOM, and scroll position is always expressed as a
 * fractional source line.
 */
import { assetUrl, ipc } from "../ipc";
import {
  adoptHashes,
  commitBlocks,
  elementForLine,
  hashesOf,
  lineAtOffset,
  lineEntries,
  offsetForLine,
  type LineEntry,
} from "../render/blocks";
import { renderClient, Superseded } from "../render/client";
import { observeMermaid } from "../render/mermaid";
import { sanitizeDocument, type GrantedImage } from "../render/sanitize";
import type { Heading, RenderOptions, RenderOutput } from "../render/types";
import { DomFinder } from "./find";
import { loadKatexCss } from "./katexStyles";


export interface PreviewCallbacks {
  /** Top-of-viewport source line changed (throttled to a frame). */
  onScrollLine(line: number, byUser: boolean, atEnd: boolean): void;
  onRendered(output: RenderOutput, initial: boolean): void;
  onError(error: Error): void;
  onLink(anchor: HTMLAnchorElement, event: MouseEvent): void;
  onImageClick(src: string): void;
  onDoubleClickLine(line: number): void;
  onContextMenu(target: { link?: HTMLAnchorElement; image?: HTMLImageElement }, event: MouseEvent): boolean;
}

export interface RenderRequest {
  path: string;
  text: string;
  version: number;
  options: RenderOptions;
  remoteImages: boolean;
  folderRoot: string | null;
  /** Tint changed blocks (live reload with the setting on). */
  tint: boolean;
}

interface ScrollAnchor {
  atTop: boolean;
  atBottom: boolean;
  line: number;
  block: HTMLElement | null;
  offset: number;
  before: (readonly [Element, number])[];
}

export interface CachedPreview {
  path: string;
  version: number;
  html: string;
  hashes: string[];
  output: RenderOutput;
}

export class PreviewController {
  readonly scroller: HTMLDivElement;
  readonly article: HTMLElement;
  readonly finder: DomFinder;
  path: string | null = null;
  version = -1;
  output: RenderOutput | null = null;
  private seq = 0;
  private entries: LineEntry[] | null = null;
  private disposeMermaid: (() => void) | null = null;
  private disposeHighlight: (() => void) | null = null;
  private highlightPath: string | null = null;
  private programmaticUntil = 0;
  private userScrolledAt = 0;
  private frame = 0;
  private stickUntil = 0;
  private stickLine: number | null = null;
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(
    host: HTMLElement,
    private readonly cb: PreviewCallbacks,
  ) {
    this.scroller = document.createElement("div");
    this.scroller.className = "preview-scroll";
    this.scroller.tabIndex = -1;
    this.scroller.setAttribute("role", "document");
    this.article = document.createElement("article");
    this.article.className = "markdown-body";
    this.scroller.appendChild(this.article);
    host.appendChild(this.scroller);
    this.finder = new DomFinder(this.article, this.scroller);

    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
      this.scroller.addEventListener(type, this.onUserIntent, { passive: true });
    }
    this.article.addEventListener("click", this.onClick);
    this.article.addEventListener("dblclick", this.onDoubleClick);
    this.article.addEventListener("contextmenu", this.onContextMenu);
    this.article.addEventListener("toggle", () => (this.entries = null), true);
    this.article.addEventListener("load", this.onMediaLoad, true);
    this.resizeObserver = new ResizeObserver(() => this.reapplyStick());
    this.resizeObserver.observe(this.article);
  }

  dispose() {
    this.disposed = true;
    this.finder.clear();
    this.disposeMermaid?.();
    this.disposeHighlight?.();
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
    this.scroller.remove();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  /** Renders `req`; resolves once committed (or superseded/failed). */
  async render(req: RenderRequest): Promise<void> {
    const seq = ++this.seq;
    const pathChanged = this.path !== req.path;
    let output: RenderOutput;
    try {
      output = await renderClient().render(req.path, req.text, req.options);
    } catch (err) {
      if (err instanceof Superseded || this.disposed) return;
      this.cb.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (seq !== this.seq || this.disposed) return;

    const local = output.images.filter((src) => !/^(https?:|data:)/i.test(src.trim()));
    let images: Record<string, GrantedImage | null> = {};
    if (local.length) {
      try {
        images = await ipc.allowImages(req.path, local, req.folderRoot);
      } catch (err) {
        console.warn("image grants failed", err);
      }
    }
    if (output.hasMath) await loadKatexCss();
    if (seq !== this.seq || this.disposed) return;

    const { fragment, hashes } = sanitizeDocument(output, {
      images,
      remoteImages: req.remoteImages,
      assetUrl,
    });
    const initial = pathChanged || this.article.childElementCount === 0;
    const anchor = initial ? null : this.captureAnchor();
    if (initial) this.article.replaceChildren();
    commitBlocks(this.article, fragment, hashes, { tint: !initial && req.tint });
    this.entries = null;
    this.path = req.path;
    this.version = req.version;
    this.output = output;
    this.syncHighlighted(output);
    this.watchHighlights(req.path);
    this.disposeMermaid?.();
    this.disposeMermaid = output.hasMermaid ? observeMermaid(this.article, this.scroller) : null;
    if (anchor) this.restoreAnchor(anchor);
    this.cb.onRendered(output, initial);
  }

  /**
   * Where the reader is, before a live reload replaces blocks: the block at
   * the top of the viewport (pinned by DOM identity when the diff keeps it),
   * plus the source line and the old lines of the blocks above it, so an
   * edited block still maps to the right line after edits above it.
   */
  private captureAnchor(): ScrollAnchor {
    const el = this.scroller;
    const blocks = Array.from(this.article.children) as HTMLElement[];
    const viewTop = el.getBoundingClientRect().top;
    // First top-level block whose bottom is below the viewport top.
    let lo = 0;
    let hi = blocks.length - 1;
    let index = blocks.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].getBoundingClientRect().bottom > viewTop + 0.5) {
        index = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const block = blocks[index] ?? null;
    return {
      atTop: el.scrollTop <= 1,
      atBottom: el.scrollTop > 1 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
      line: this.topLine(),
      block,
      offset: block ? block.getBoundingClientRect().top - viewTop : 0,
      before: blocks.slice(Math.max(0, index - 50), index + 1).map((b) => [b, Number(b.dataset.sourceLine)] as const),
    };
  }

  private restoreAnchor(anchor: ScrollAnchor) {
    const el = this.scroller;
    this.programmaticUntil = performance.now() + 120;
    if (anchor.atTop) {
      el.scrollTop = 0;
      return;
    }
    if (anchor.atBottom) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const block = anchor.block;
    if (block && block.parentElement === this.article) {
      const now = block.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop += now - anchor.offset;
      return;
    }
    // The block at the top changed: shift the line by however far the
    // nearest surviving block above it moved.
    let delta = 0;
    for (let i = anchor.before.length - 1; i >= 0; i--) {
      const [prev, oldLine] = anchor.before[i];
      if (prev.parentElement !== this.article || !Number.isFinite(oldLine)) continue;
      const newLine = Number((prev as HTMLElement).dataset.sourceLine);
      if (Number.isFinite(newLine)) delta = newLine - oldLine;
      break;
    }
    this.scrollToLine(Math.max(0, anchor.line + delta));
  }

  /** Rebuilds from cached HTML (tabs outside the mounted set). */
  restore(cache: CachedPreview) {
    this.article.innerHTML = cache.html;
    adoptHashes(this.article, cache.hashes);
    this.entries = null;
    this.path = cache.path;
    this.version = cache.version;
    this.output = cache.output;
    this.watchHighlights(cache.path);
    this.disposeMermaid?.();
    this.disposeMermaid = cache.output.hasMermaid ? observeMermaid(this.article, this.scroller) : null;
  }

  snapshot(): CachedPreview | null {
    if (!this.path || !this.output) return null;
    return {
      path: this.path,
      version: this.version,
      html: this.article.innerHTML,
      hashes: hashesOf(this.article),
      output: this.output,
    };
  }

  /** Re-renders Mermaid diagrams for a new theme or appearance. */
  retheme() {
    if (!this.output?.hasMermaid) return;
    this.disposeMermaid?.();
    this.disposeMermaid = observeMermaid(this.article, this.scroller);
  }

  private watchHighlights(path: string) {
    if (this.highlightPath === path) return;
    this.disposeHighlight?.();
    this.highlightPath = path;
    this.disposeHighlight = renderClient().onHighlight(path, (blocks) => {
      const template = document.createElement("template");
      for (const { key, html } of blocks) {
        for (const block of Array.from(this.article.querySelectorAll(`.code-block[data-hl="${CSS.escape(key)}"]`))) {
          template.innerHTML = html;
          const pre = template.content.querySelector("pre");
          const old = block.querySelector("pre");
          if (pre && old) old.replaceWith(pre);
        }
        if (this.output && this.output.slots[key]) {
          // Keep the cached output in sync for tab restores.
          const slot = this.output.slots[key];
          this.output.slots[key] = slot.replace(/<pre[\s\S]*<\/pre>/, html);
        }
      }
    });
  }

  /** Reused blocks may still be plain although the new render is colored. */
  private syncHighlighted(output: RenderOutput) {
    const template = document.createElement("template");
    for (const pre of Array.from(this.article.querySelectorAll(".code-block pre.plain"))) {
      const key = (pre.closest(".code-block") as HTMLElement | null)?.dataset.hl;
      const slot = key ? output.slots[key] : undefined;
      if (!slot || slot.includes("shiki folio plain")) continue;
      template.innerHTML = slot;
      const fresh = template.content.querySelector("pre");
      if (fresh) pre.replaceWith(fresh);
    }
  }

  // ─── Geometry and scrolling ────────────────────────────────────────────

  private lineEntries(): LineEntry[] {
    this.entries ??= lineEntries(this.article);
    return this.entries;
  }

  topLine(): number {
    return lineAtOffset(this.lineEntries(), this.scroller, this.scroller.scrollTop);
  }

  scrollToLine(line: number, options: { stick?: boolean } = {}) {
    const y = offsetForLine(this.lineEntries(), this.scroller, line);
    this.programmaticUntil = performance.now() + 120;
    this.scroller.scrollTop = Math.max(0, y);
    if (options.stick) {
      // Images above may still load and push content down: hold the line
      // for a moment unless the user scrolls.
      this.stickLine = line;
      this.stickUntil = performance.now() + 2500;
    }
  }

  /** Scrolls to `#fragment` (GitHub ids carry a `user-content-` prefix). */
  scrollToFragment(fragment: string): boolean {
    let decoded = fragment;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      /* keep raw */
    }
    const candidates = [decoded, `user-content-${decoded}`, decoded.toLowerCase(), `user-content-${decoded.toLowerCase()}`];
    for (const id of candidates) {
      const el =
        this.article.querySelector(`[id="${CSS.escape(id)}"]`) ?? this.article.querySelector(`[name="${CSS.escape(id)}"]`);
      if (el) {
        const top = el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
        this.programmaticUntil = performance.now() + 120;
        this.scroller.scrollTop = Math.max(0, top - 16);
        this.stickLine = this.topLine();
        this.stickUntil = performance.now() + 1500;
        return true;
      }
    }
    return false;
  }

  scrollToTop() {
    this.programmaticUntil = performance.now() + 120;
    this.scroller.scrollTop = 0;
  }

  /** Content offset (px) for split-view sync from another pane. */
  scrollToLineSync(line: number) {
    const y = offsetForLine(this.lineEntries(), this.scroller, line);
    this.programmaticUntil = performance.now() + 120;
    this.scroller.scrollTop = Math.max(0, y);
  }

  private reapplyStick() {
    if (this.stickLine === null) return;
    if (performance.now() > this.stickUntil || this.userScrolledAt > this.stickUntil - 2500) {
      this.stickLine = null;
      return;
    }
    this.scrollToLineSync(this.stickLine);
  }

  private onMediaLoad = (e: Event) => {
    if ((e.target as HTMLElement).tagName === "IMG") this.reapplyStick();
  };

  private onUserIntent = () => {
    this.userScrolledAt = performance.now();
    this.stickLine = null;
  };

  private onScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const byUser = performance.now() > this.programmaticUntil;
      const el = this.scroller;
      const atEnd = el.scrollTop > 0 && el.scrollHeight > el.clientHeight + 2 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      this.cb.onScrollLine(this.topLine(), byUser, atEnd);
    });
  };

  headingJump(headings: Heading[], direction: 1 | -1) {
    if (!headings.length) return;
    const current = this.topLine();
    const target =
      direction > 0
        ? headings.find((h) => h.line > current + 0.5)
        : [...headings].reverse().find((h) => h.line < current - 0.05);
    if (target) this.scrollToFragment(target.id);
  }

  focus() {
    this.scroller.focus({ preventScroll: true });
  }

  selectAll() {
    const sel = window.getSelection();
    sel?.selectAllChildren(this.article);
  }

  // ─── Events ────────────────────────────────────────────────────────────

  private onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLButtonElement>(".code-copy");
    if (copy) {
      e.preventDefault();
      const code = copy.closest(".code-block")?.querySelector("pre code, pre")?.textContent ?? "";
      void ipc.copyToClipboard(code);
      copy.classList.add("copied");
      copy.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        copy.classList.remove("copied");
        copy.setAttribute("aria-label", "Copy code");
      }, 1400);
      return;
    }
    const anchor = target.closest("a");
    if (anchor) {
      e.preventDefault();
      if (anchor.hasAttribute("href")) this.cb.onLink(anchor, e);
      return;
    }
    if (target instanceof HTMLImageElement && target.getAttribute("src") && !target.closest("a")) {
      this.cb.onImageClick(target.currentSrc || target.src);
    }
  };

  /** Double-clicking a rendered block jumps to its line in Code view. */
  private onDoubleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("a, button, summary, img, .code-header, input")) return;
    const block = target.closest<HTMLElement>("[data-source-line]");
    if (!block) return;
    this.cb.onDoubleClickLine(Number(block.dataset.sourceLine));
  };

  private onContextMenu = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest("a[href]") as HTMLAnchorElement | null;
    const image = target instanceof HTMLImageElement ? target : null;
    const selection = window.getSelection();
    const hasSelection = !!selection && !selection.isCollapsed && selection.toString().length > 0;
    if ((link || image) && !hasSelection) {
      if (this.cb.onContextMenu({ link: link ?? undefined, image: image ?? undefined }, e)) e.preventDefault();
    }
    // Otherwise WebKit's own menu (Look Up, Translate, Share, Speech).
  };

  /** Block element at a source line (for flashes and outline sync). */
  elementForLine(line: number): HTMLElement | null {
    return elementForLine(this.lineEntries(), line);
  }
}
