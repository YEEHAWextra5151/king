import { describe, expect, it } from "vitest";
import { highlightPending, renderDocument, warm } from "../renderer";
import { parseEntries } from "../plugins/frontMatter";

const render = async (text: string, frontMatter: "hidden" | "card" = "hidden") =>
  (await renderDocument(text, { frontMatter })).output;

describe("heading anchors", () => {
  it("match GitHub's slugs", async () => {
    const out = await render(
      [
        "# Installation",
        "## What's new?",
        "## Usage",
        "## Usage",
        "## :rocket: Setup",
        "## 🚀 Launch",
        "## `code` Heading",
        "## C++ & Rust",
        "## Über Cool",
        "## Links [here](https://x.io) and <b>bold</b>",
      ].join("\n\n"),
    );
    expect(out.headings.map((h) => h.id)).toEqual([
      "installation",
      "whats-new",
      "usage",
      "usage-1",
      "rocket-setup",
      "-launch",
      "code-heading",
      "c--rust",
      "über-cool",
      "links-here-and-bold",
    ]);
    expect(out.headings[4].text).toBe("🚀 Setup");
    expect(out.html).toContain('<h1 id="installation"');
  });
});

describe("source lines", () => {
  it("tag blocks with their lines", async () => {
    const out = await render("# T\n\npara one\nstill\n\n- a\n- b\n\n```js\nx\n```\n");
    expect(out.html).toContain('<h1 id="t" data-source-line="0" data-source-line-end="1"');
    expect(out.html).toContain('<p data-source-line="2" data-source-line-end="4">');
    expect(out.html).toMatch(/<ul data-source-line="5"/);
    expect(out.html).toMatch(/class="code-block" data-source-line="8" data-source-line-end="11"/);
  });
});

describe("front matter", () => {
  const doc = "---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n# Body\n";
  it("is hidden by default", async () => {
    const out = await render(doc);
    expect(out.html).not.toContain("title");
    expect(out.html).not.toContain("<hr");
    expect(out.frontMatter?.entries).toEqual([
      ["title", "Hello"],
      ["tags", "a, b"],
    ]);
    expect(out.headings[0].line).toBe(6);
  });
  it("renders as a card", async () => {
    const out = await render(doc, "card");
    expect(out.html).toContain('<div class="front-matter" data-source-line="0" data-source-line-end="6"><dl><dt>title</dt><dd>Hello</dd>');
  });
  it("supports TOML and leaves plain thematic breaks alone", async () => {
    expect(parseEntries('title = "T"\n[extra]\nk = [1, 2]', "toml")).toEqual([
      ["title", "T"],
      ["extra.k", "1, 2"],
    ]);
    const out = await render("---\n\ntext");
    expect(out.html).toContain("<hr");
  });
});

describe("GitHub extensions", () => {
  it("renders alerts with source lines", async () => {
    const out = await render("> [!WARNING]\n> Careful <script>\n");
    expect(out.html).toContain('class="markdown-alert markdown-alert-warning" data-source-line="0"');
    expect(out.html).toContain("Warning</p>");
  });
  it("renders task lists as disabled checkboxes", async () => {
    const out = await render("- [ ] todo\n- [x] done\n- normal\n");
    expect(out.html).toContain('class="contains-task-list"');
    expect(out.html).toContain('<li class="task-list-item"');
    expect(out.html).toContain('<input type="checkbox" class="task-list-item-checkbox" disabled checked');
    expect(out.html).toMatch(/<input type="checkbox" class="task-list-item-checkbox" disabled aria-label="Not completed"> todo/);
  });
  it("aligns table cells without inline styles", async () => {
    const out = await render("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n");
    expect(out.html).toContain('<div class="table-wrap"><table');
    expect(out.html).toContain('<th align="left"');
    expect(out.html).toContain('<td align="right"');
    expect(out.html).not.toContain("style=");
  });
  it("autolinks like GFM", async () => {
    const out = await render("see www.example.com, https://x.io/a, example.com and me@x.io");
    expect(out.html).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(out.html).toContain('<a href="https://x.io/a">https://x.io/a</a>');
    expect(out.html).toContain('<a href="mailto:me@x.io">me@x.io</a>');
    expect(out.html).not.toContain('href="http://example.com"');
  });
  it("renders footnotes, strikethrough and emoji", async () => {
    const out = await render("Hi[^1] ~~old~~ :tada:\n\n[^1]: Note.\n");
    expect(out.html).toContain('<sup class="footnote-ref"><a href="#fn1" id="fnref1">');
    expect(out.html).toContain("<s>old</s>");
    expect(out.html).toContain("🎉");
    expect(out.html).toContain("data-footnotes");
  });
});

describe("math", () => {
  it("renders inline and block math into trusted slots", async () => {
    const out = await render("Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x\\,dx\n$$\n");
    expect(out.hasMath).toBe(true);
    const slots = Object.values(out.slots);
    expect(slots.some((s) => s.includes('class="katex"'))).toBe(true);
    expect(slots.some((s) => s.includes("katex-display"))).toBe(true);
    expect(out.html).toMatch(/<span class="math-inline"><folio-slot data-k="[0-9a-f]+:i\w+"><\/folio-slot><\/span>/);
    expect(out.html).toMatch(/<div class="math-block" data-source-line="2" data-source-line-end="5">/);
  });
  it("does not treat prices as math", async () => {
    const out = await render("It costs $5 and $10.");
    expect(out.hasMath).toBe(false);
    expect(out.html).toContain("$5 and $10");
  });
  it("shows errors with the source", async () => {
    const out = await render("$\\frac{1$\n");
    const slot = Object.values(out.slots)[0];
    expect(slot).toContain("render-error");
    expect(slot).toContain("\\frac{1");
  });
  it("supports math fences", async () => {
    const out = await render("```math\nx^2\n```\n");
    expect(Object.values(out.slots)[0]).toContain("katex-display");
  });
});

describe("code", () => {
  it("renders plain first, then highlights once the grammar loads", async () => {
    const src = "```ts\nconst a: number = 1;\n```\n";
    const first = await renderDocument(src, { frontMatter: "hidden" });
    expect(first.output.pending).toHaveLength(1);
    const slot = Object.values(first.output.slots)[0];
    expect(slot).toContain('<span class="code-lang">TypeScript</span>');
    expect(slot).toContain("shiki folio plain");
    await first.grammars;
    const blocks = highlightPending(first.output.pending);
    expect(blocks[0].html).toContain("var(--shiki-token-keyword)");
    // The next render uses the cache and highlights synchronously.
    const second = await render(src);
    expect(second.pending).toHaveLength(0);
    expect(Object.values(second.slots)[0]).toContain("var(--shiki-token-keyword)");
  });
  it("keeps slot keys stable across renders", async () => {
    const a = await render("```py\nprint(1)\n```\n");
    const b = await render("text\n\n```py\nprint(1)\n```\n");
    expect(Object.keys(a.slots)).toEqual(Object.keys(b.slots));
    expect(a.nonce).not.toEqual(b.nonce);
  });
  it("labels unknown languages and escapes content", async () => {
    await warm(["python"]);
    const out = await render("```weird-lang\n<b>&</b>\n```\n");
    const slot = Object.values(out.slots)[0];
    expect(slot).toContain('<span class="code-lang">weird-lang</span>');
    expect(slot).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(out.pending).toHaveLength(0);
  });
  it("renders mermaid as a lazy placeholder", async () => {
    const out = await render("```mermaid\ngraph TD; A-->B<script>\n```\n");
    expect(out.hasMermaid).toBe(true);
    expect(out.html).toContain('<div class="mermaid-block" data-source-line="0" data-source-line-end="3" data-mermaid="');
    expect(out.html).toContain("A--&gt;B&lt;script&gt;");
  });
});

describe("images and stats", () => {
  it("collects every referenced image", async () => {
    const out = await render(
      '![a](img/a.png)\n\n<img src="b.png" width=10>\n\n<picture><source srcset="c.png 1x, d.png 2x"><img src=\'e.png\'></picture>\n\nText <img src=f.svg> inline',
    );
    expect(out.images.sort()).toEqual(["b.png", "c.png", "d.png", "e.png", "f.svg", "img/a.png"]);
  });
  it("counts words outside code", async () => {
    const out = await render("One two three.\n\n```\nnot counted here\n```\n\nIt's `four` five.\n");
    expect(out.stats.words).toBe(6);
    expect(out.stats.lines).toBe(7);
  });
});
