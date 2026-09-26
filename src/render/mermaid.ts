/**
 * Mermaid, imported only when a document has a `mermaid` fence and rendered
 * only when a diagram scrolls near the viewport. Themed from the palette
 * (`theme: "base"` + themeVariables), `securityLevel: "strict"`, and the
 * SVG is sanitized again before insertion.
 */
import { escapeHtml, hash, Lru } from "./hash";
import { sanitizeSvg } from "./sanitize";

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
let initializedFor: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;
const cache = new Lru<string, string>(200);

function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function themeKey(): string {
  return [
    document.documentElement.dataset.theme,
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    token("--mermaid-surface", ""),
  ].join("|");
}

function themeVariables(dark: boolean) {
  return {
    darkMode: dark,
    background: token("--mermaid-surface", dark ? "#262624" : "#FAF9F5"),
    fontFamily: token("--font-ui", "-apple-system, BlinkMacSystemFont, sans-serif"),
    fontSize: "14px",
    primaryColor: token("--mermaid-node", dark ? "#30302E" : "#F0EEE6"),
    primaryTextColor: token("--mermaid-text", dark ? "#E8E6DC" : "#141413"),
    primaryBorderColor: token("--mermaid-border", dark ? "#6F6E69" : "#B5B3AA"),
    secondaryColor: token("--mermaid-node-alt", dark ? "#1F1E1D" : "#F5F4ED"),
    tertiaryColor: token("--mermaid-node-tertiary", dark ? "#262624" : "#FFFFFF"),
    lineColor: token("--mermaid-line", dark ? "#9C9A92" : "#73726C"),
    textColor: token("--mermaid-text", dark ? "#E8E6DC" : "#141413"),
    mainBkg: token("--mermaid-node", dark ? "#30302E" : "#F0EEE6"),
    nodeBorder: token("--mermaid-border", dark ? "#6F6E69" : "#B5B3AA"),
    clusterBkg: token("--mermaid-node-alt", dark ? "#1F1E1D" : "#F5F4ED"),
    clusterBorder: token("--mermaid-border", dark ? "#6F6E69" : "#B5B3AA"),
    edgeLabelBackground: token("--mermaid-surface", dark ? "#262624" : "#FAF9F5"),
    noteBkgColor: token("--mermaid-note", dark ? "#483A0F" : "#F6EEDF"),
    noteTextColor: token("--mermaid-note-text", dark ? "#D1A041" : "#5A4815"),
    noteBorderColor: token("--mermaid-note-border", dark ? "#6B5718" : "#D8C49A"),
    actorBkg: token("--mermaid-node", dark ? "#30302E" : "#F0EEE6"),
    actorBorder: token("--mermaid-border", dark ? "#6F6E69" : "#B5B3AA"),
    actorTextColor: token("--mermaid-text", dark ? "#E8E6DC" : "#141413"),
    signalColor: token("--mermaid-line", dark ? "#9C9A92" : "#73726C"),
    signalTextColor: token("--mermaid-text", dark ? "#E8E6DC" : "#141413"),
    labelBoxBkgColor: token("--mermaid-node", dark ? "#30302E" : "#F0EEE6"),
    pie1: token("--accent", "#D97757"),
  };
}

async function renderSource(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  const key = themeKey();
  if (initializedFor !== key) {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: themeVariables(dark),
      fontFamily: token("--font-ui", "-apple-system, sans-serif"),
      flowchart: { htmlLabels: true, curve: "basis" },
      suppressErrorRendering: true,
    } as Parameters<Mermaid["initialize"]>[0]);
    initializedFor = key;
  }
  const id = `folio-mermaid-${++counter}`;
  const { svg } = await mermaid.render(id, source);
  return sanitizeSvg(svg);
}

/** Renders one `.mermaid-block` (serialized: Mermaid isn't reentrant). */
export function renderMermaidBlock(block: HTMLElement): Promise<void> {
  const source = block.querySelector(".mermaid-source")?.textContent ?? "";
  const cacheKey = hash(source) + "|" + themeKey();
  block.dataset.rendered = cacheKey;
  const task = queue.then(async () => {
    let svg = cache.get(cacheKey);
    if (!svg) {
      try {
        svg = await renderSource(source);
        cache.set(cacheKey, svg);
      } catch (err) {
        showError(block, source, err);
        return;
      }
    }
    if (block.dataset.rendered !== cacheKey) return; // re-themed meanwhile
    let target = block.querySelector<HTMLElement>(".mermaid-diagram");
    if (!target) {
      target = document.createElement("div");
      target.className = "mermaid-diagram";
      target.setAttribute("role", "img");
      target.setAttribute("aria-label", "Diagram");
      block.prepend(target);
    }
    target.innerHTML = svg;
    block.classList.add("is-rendered");
    block.classList.remove("has-error");
    block.querySelector(".render-error")?.remove();
  });
  queue = task.catch(() => undefined);
  return task;
}

function showError(block: HTMLElement, source: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  block.classList.add("has-error");
  block.querySelector(".render-error")?.remove();
  block.querySelector(".mermaid-diagram")?.remove();
  const box = document.createElement("div");
  box.className = "render-error";
  box.setAttribute("role", "note");
  box.innerHTML = `<div class="render-error-title">Diagram error</div><div class="render-error-message">${escapeHtml(
    message.split("\n").slice(0, 6).join("\n"),
  )}</div><pre class="render-error-source">${escapeHtml(source)}</pre>`;
  block.prepend(box);
}

/**
 * Observes the diagrams under `root` that aren't rendered for the current
 * theme, and renders each as it comes within ~1000px of the viewport. Call
 * again after each commit or theme change (disposing the previous one).
 */
export function observeMermaid(root: HTMLElement, scroller: HTMLElement): () => void {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        void renderMermaidBlock(entry.target as HTMLElement);
      }
    },
    { root: scroller, rootMargin: "1000px 0px" },
  );
  const key = themeKey();
  for (const block of Array.from(root.querySelectorAll<HTMLElement>(".mermaid-block"))) {
    const wanted = hash(block.querySelector(".mermaid-source")?.textContent ?? "") + "|" + key;
    if (block.dataset.rendered !== wanted) observer.observe(block);
  }
  return () => observer.disconnect();
}
