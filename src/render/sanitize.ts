/**
 * Sanitizing document HTML on the main thread (DOMPurify needs a DOM).
 *
 * A GitHub-like allowlist: no scripts, iframes, forms, event handlers,
 * `style` attributes or javascript: URLs. `id`/`name` get GitHub's
 * `user-content-` prefix (DOM clobbering protection). Trusted Shiki/KaTeX
 * output is filled in afterwards from the render's slot table.
 */
import DOMPurify, { type Config } from "dompurify";
import { hash } from "./hash";
import { srcsetUrls } from "./plugins/images";
import type { RenderOutput } from "./types";

export interface GrantedImage {
  path: string;
  width?: number | null;
  height?: number | null;
}

export interface SanitizeContext {
  /** src → granted local image (null when it isn't one). */
  images: Record<string, GrantedImage | null>;
  remoteImages: boolean;
  /** Maps a granted path to a URL the webview can load. */
  assetUrl: (path: string) => string;
}

const TAGS = [
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "center", "cite", "code", "col",
  "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li", "mark", "ol",
  "p", "picture", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "source",
  "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "time", "tr", "tt", "u", "ul", "var", "wbr", "folio-slot",
  // Minimal SVG for alert icons and simple inline drawings.
  "svg", "path", "g", "circle", "rect", "line", "polyline", "polygon", "ellipse", "title",
];

const ATTRS = [
  "href", "src", "srcset", "sizes", "media", "type", "alt", "title", "width", "height", "align",
  "valign", "colspan", "rowspan", "id", "name", "class", "open", "start", "reversed", "checked",
  "disabled", "lang", "dir", "datetime", "cite", "abbr", "headers", "scope", "decoding", "role",
  "aria-label", "aria-hidden", "data-source-line", "data-source-line-end", "data-lang", "data-hl",
  "data-k", "data-mermaid", "data-footnotes", "data-footnote-ref", "data-footnote-backref",
  "data-remote-src",
  // SVG
  "viewbox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule",
  "clip-rule", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points",
  "transform", "version", "xmlns", "opacity",
];

const CONFIG: Config = {
  ALLOWED_TAGS: TAGS,
  ALLOWED_ATTR: ATTRS,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  SANITIZE_NAMED_PROPS: true,
  // http(s), mailto, file, fragments and relative URLs; everything else
  // (javascript:, vbscript:, custom schemes) is dropped.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  ADD_URI_SAFE_ATTR: [],
  RETURN_DOM_FRAGMENT: true,
};

let ctx: SanitizeContext | null = null;
let hooked = false;

function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function rewriteUrl(raw: string): { url: string | null; image?: GrantedImage; blocked?: boolean } {
  const src = raw.trim();
  if (!ctx) return { url: null };
  if (isRemote(src)) return ctx.remoteImages ? { url: src } : { url: null, blocked: true };
  if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(src)) return { url: src };
  const granted = ctx.images[src];
  if (granted) return { url: ctx.assetUrl(granted.path), image: granted };
  return { url: null };
}

function installHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    switch (el.tagName) {
      case "IMG": {
        const src = el.getAttribute("src");
        if (src !== null) {
          const r = rewriteUrl(src);
          if (r.url) {
            el.setAttribute("src", r.url);
            // Reserve space before the image loads.
            if (r.image?.width && r.image.height && !el.hasAttribute("width") && !el.hasAttribute("height")) {
              el.setAttribute("width", String(r.image.width));
              el.setAttribute("height", String(r.image.height));
            }
          } else {
            el.removeAttribute("src");
            el.classList.add(r.blocked ? "image-blocked" : "image-missing");
            if (r.blocked) el.setAttribute("data-remote-src", src);
            if (!el.getAttribute("title")) {
              el.setAttribute("title", r.blocked ? `Remote image blocked: ${src}` : `Image not found: ${src}`);
            }
          }
        }
        el.setAttribute("decoding", "async");
        if (el.hasAttribute("srcset")) rewriteSrcset(el);
        break;
      }
      case "SOURCE":
        if (el.hasAttribute("srcset")) rewriteSrcset(el);
        el.removeAttribute("src");
        break;
      case "A": {
        // Our click handler routes links; never let WebKit follow one.
        el.removeAttribute("target");
        break;
      }
      default:
        break;
    }
  });
}

function rewriteSrcset(el: Element) {
  const value = el.getAttribute("srcset") ?? "";
  const parts: string[] = [];
  for (const candidate of value.split(",")) {
    const [url, ...descriptor] = candidate.trim().split(/\s+/);
    if (!url) continue;
    const r = rewriteUrl(url);
    if (r.url) parts.push([r.url, ...descriptor].join(" "));
  }
  if (parts.length) el.setAttribute("srcset", parts.join(", "));
  else el.removeAttribute("srcset");
}

export interface SanitizedDocument {
  fragment: DocumentFragment;
  /** Content hash per top-level block (stable across renders). */
  hashes: string[];
}

/**
 * Sanitizes the render's HTML, normalizes top-level structure, hashes each
 * block, then fills trusted slots.
 */
export function sanitizeDocument(output: RenderOutput, context: SanitizeContext): SanitizedDocument {
  installHooks();
  ctx = context;
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(output.html, CONFIG) as unknown as DocumentFragment;
  } finally {
    ctx = null;
  }
  // Only (disabled) checkboxes survive as form controls.
  for (const input of Array.from(fragment.querySelectorAll("input"))) {
    if (input.getAttribute("type") !== "checkbox") input.remove();
    else input.setAttribute("disabled", "");
  }
  wrapStrayInlines(fragment);
  const hashes = Array.from(fragment.children, (el) => blockHash(el, output.nonce));
  fillSlots(fragment, output);
  return { fragment, hashes };
}

const LINE_ATTRS = / data-source-line(?:-end)?="\d+"/g;

/**
 * A block's identity for diffing: its HTML without the per-render nonce
 * and without source lines (which shift whenever something above changes).
 */
export function blockHash(el: Element, nonce: string): string {
  return hash(el.outerHTML.split(nonce).join("").replace(LINE_ATTRS, ""));
}

/** Raw HTML can leave text or inline elements at the top level; group them. */
function wrapStrayInlines(fragment: DocumentFragment) {
  const BLOCKS = new Set([
    "P", "DIV", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TABLE", "HR", "H1", "H2", "H3", "H4",
    "H5", "H6", "DETAILS", "SECTION", "FIGURE", "DL", "CENTER", "PICTURE",
  ]);
  let run: Node[] = [];
  const flush = (before: Node | null) => {
    if (run.length === 0) return;
    const onlyWhitespace = run.every((n) => n.nodeType === Node.TEXT_NODE && !n.textContent?.trim());
    if (onlyWhitespace) {
      run.forEach((n) => n.parentNode?.removeChild(n));
    } else {
      const wrapper = fragment.ownerDocument!.createElement("div");
      wrapper.className = "html-run";
      fragment.insertBefore(wrapper, before);
      run.forEach((n) => wrapper.appendChild(n));
    }
    run = [];
  };
  for (const node of Array.from(fragment.childNodes)) {
    const isBlock = node.nodeType === Node.ELEMENT_NODE && BLOCKS.has((node as Element).tagName);
    if (isBlock) flush(node);
    else if (node.nodeType === Node.COMMENT_NODE) node.parentNode?.removeChild(node);
    else run.push(node);
  }
  flush(null);
}

let template: HTMLTemplateElement | null = null;

/** Replaces `<folio-slot>`s with trusted HTML; drops forged ones. */
export function fillSlots(root: ParentNode, output: RenderOutput) {
  template ??= document.createElement("template");
  for (const el of Array.from(root.querySelectorAll("folio-slot"))) {
    const k = el.getAttribute("data-k") ?? "";
    const sep = k.indexOf(":");
    const nonce = k.slice(0, sep);
    const key = k.slice(sep + 1);
    const html = nonce === output.nonce ? output.slots[key] : undefined;
    if (html === undefined) {
      el.remove();
      continue;
    }
    template.innerHTML = html;
    el.replaceWith(template.content.cloneNode(true));
  }
}

/** Mermaid output: SVG (with HTML labels in foreignObject), no scripts. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject", "style"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "a"],
    FORBID_ATTR: ["href", "xlink:href"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  }) as string;
}

export { srcsetUrls };
