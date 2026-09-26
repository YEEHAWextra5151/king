// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderDocument } from "../renderer";
import { commitBlocks, lineAtOffset, lineEntries, offsetForLine } from "../blocks";
import { sanitizeDocument, sanitizeSvg, type SanitizeContext } from "../sanitize";

const ctx = (over: Partial<SanitizeContext> = {}): SanitizeContext => ({
  images: {},
  remoteImages: true,
  assetUrl: (p) => `asset://localhost/${encodeURIComponent(p)}`,
  ...over,
});

async function build(md: string, context = ctx()) {
  const { output } = await renderDocument(md, { frontMatter: "hidden" });
  return { output, ...sanitizeDocument(output, context) };
}

function html(fragment: DocumentFragment): string {
  const div = document.createElement("div");
  div.appendChild(fragment.cloneNode(true));
  return div.innerHTML;
}

describe("sanitizer", () => {
  it("strips scripts, handlers, iframes, forms, styles and javascript: URLs", async () => {
    const { fragment } = await build(
      [
        '<script>alert(1)</script>',
        '<img src="x.png" onerror="alert(1)">',
        '<iframe src="https://evil"></iframe>',
        '<form action="/x"><input type="text" name="q"><button>go</button></form>',
        '<div style="position:fixed;inset:0">overlay</div>',
        '[click](javascript:alert(1)) <a href="vbscript:x">v</a> <a href="vscode://file/x">c</a>',
        '<a href="https://ok.example" target="_blank" onclick="x()">ok</a>',
      ].join("\n\n"),
    );
    const out = html(fragment);
    expect(out).not.toMatch(/<script|onerror|onclick|<iframe|<form|<button|style=|href="(javascript|vbscript|vscode):|target=/i);
    // markdown-it refuses the javascript: link, leaving it as text.
    expect(out).toContain("[click](javascript:alert(1))");
    expect(out).toContain('<a href="https://ok.example">ok</a>');
    expect(out).toContain("overlay");
    expect(fragment.querySelectorAll("input").length).toBe(0);
  });

  it("keeps GitHub's HTML subset", async () => {
    const { fragment } = await build(
      '<details open><summary>More</summary>\n\nHidden **text**\n\n</details>\n\n<p align="center"><kbd>⌘</kbd> H<sub>2</sub>O x<sup>2</sup><br></p>\n\n<picture><source media="(prefers-color-scheme: dark)" srcset="https://x.io/d.png"><img src="https://x.io/l.png" width="100" height="50" align="right" alt="logo"></picture>',
    );
    const out = html(fragment);
    expect(out).toContain("<details open");
    expect(out).toContain("<summary>More</summary>");
    expect(out).toContain("<strong>text</strong>");
    expect(out).toContain('<p align="center"><kbd>⌘</kbd>');
    expect(out).toContain('<source media="(prefers-color-scheme: dark)" srcset="https://x.io/d.png">');
    expect(out).toContain('width="100" height="50" align="right"');
  });

  it("prefixes ids like GitHub and keeps task checkboxes disabled", async () => {
    const { fragment } = await build("# Title\n\n- [x] done\n\n<a name=\"top\"></a>\n");
    expect(fragment.querySelector("h1")?.id).toBe("user-content-title");
    expect(fragment.querySelector("a[name]")?.getAttribute("name")).toBe("user-content-top");
    const box = fragment.querySelector("input")!;
    expect(box.hasAttribute("disabled")).toBe(true);
    expect(box.hasAttribute("checked")).toBe(true);
  });

  it("rewrites granted local images and reserves their size", async () => {
    const { fragment } = await build("![a](img/a.png) ![b](missing.png)", ctx({
      images: { "img/a.png": { path: "/docs/img/a.png", width: 640, height: 480 }, "missing.png": null },
    }));
    const [a, b] = Array.from(fragment.querySelectorAll("img"));
    expect(a.getAttribute("src")).toBe("asset://localhost/%2Fdocs%2Fimg%2Fa.png");
    expect(a.getAttribute("width")).toBe("640");
    expect(b.hasAttribute("src")).toBe(false);
    expect(b.classList.contains("image-missing")).toBe(true);
  });

  it("blocks remote images when asked", async () => {
    const { fragment } = await build("![r](https://x.io/r.png)", ctx({ remoteImages: false }));
    const img = fragment.querySelector("img")!;
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.getAttribute("data-remote-src")).toBe("https://x.io/r.png");
  });

  it("fills trusted slots and drops forged ones", async () => {
    const { fragment } = await build('```js\nlet a = 1\n```\n\n<folio-slot data-k="guess:c123"></folio-slot>\n\n$x^2$');
    expect(fragment.querySelector("folio-slot")).toBeNull();
    expect(fragment.querySelector(".code-block pre.shiki")).not.toBeNull();
    expect(fragment.querySelector(".code-block .code-copy")).not.toBeNull();
    expect(fragment.querySelector(".katex")).not.toBeNull();
  });

  it("sanitizes Mermaid SVG", () => {
    const svg = sanitizeSvg(
      '<svg><script>alert(1)</script><g onclick="x()"><a href="javascript:x"><text>t</text></a><foreignObject><div onclick="y()">label</div></foreignObject></g></svg>',
    );
    expect(svg).not.toMatch(/script|onclick|javascript/);
    expect(svg).toContain("label");
  });
});

describe("block commits", () => {
  it("keeps unchanged blocks and replaces changed ones", async () => {
    const container = document.createElement("article");
    const a = await build("# One\n\npara A\n\npara B\n");
    commitBlocks(container, a.fragment, a.hashes, { tint: true });
    const [h1, pA, pB] = Array.from(container.children);
    const b = await build("# One\n\npara A changed\n\npara B\n\nnew\n");
    const result = commitBlocks(container, b.fragment, b.hashes, { tint: true });
    const children = Array.from(container.children);
    expect(children[0]).toBe(h1);
    expect(children[1]).not.toBe(pA);
    expect(children[2]).toBe(pB);
    expect(children).toHaveLength(4);
    expect(result.changed).toHaveLength(2);
    expect(children[1].classList.contains("block-changed")).toBe(true);
  });

  it("keeps code blocks when only text above them moves", async () => {
    const container = document.createElement("article");
    const a = await build("intro\n\n```py\nprint(1)\n```\n");
    commitBlocks(container, a.fragment, a.hashes, { tint: false });
    const code = container.querySelector(".code-block");
    const b = await build("new intro\n\nmore\n\n```py\nprint(1)\n```\n");
    commitBlocks(container, b.fragment, b.hashes, { tint: false });
    expect(container.querySelector(".code-block")).toBe(code);
    // …and its source lines follow the edit.
    expect(code?.getAttribute("data-source-line")).toBe("4");
  });
});

describe("line geometry", () => {
  it("maps offsets to lines and back", async () => {
    const scroller = document.createElement("div");
    const article = document.createElement("article");
    scroller.appendChild(article);
    document.body.appendChild(scroller);
    const a = await build("# A\n\np1\n\np2\n\np3\n");
    commitBlocks(article, a.fragment, a.hashes, { tint: false });
    // jsdom has no layout: fake one block per 100px.
    const blocks = Array.from(article.querySelectorAll<HTMLElement>("[data-source-line]"));
    blocks.forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: i * 100, height: 100, bottom: i * 100 + 100 } as DOMRect);
      el.getClientRects = () => [{}] as unknown as DOMRectList;
    });
    scroller.getBoundingClientRect = () => ({ top: 0, height: 300 } as DOMRect);
    const entries = lineEntries(article);
    expect(entries.map((e) => e.line)).toEqual([0, 2, 4, 6]);
    expect(lineAtOffset(entries, scroller, 150)).toBeCloseTo(2.5);
    expect(offsetForLine(entries, scroller, 4.5)).toBeCloseTo(250);
  });
});
