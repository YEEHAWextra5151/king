// Drives the production frontend (dist/) in Chromium with a mocked Tauri
// runtime and the production CSP: functional checks, timings, and
// screenshots for visual review.
//
//   pnpm build && node e2e/run.mjs [scenario …]
import { chromium } from "@playwright/test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const OUT = join(here, "..", "test-results", "e2e");
const FIXTURES = join(here, "fixtures", "project");
const ROOT = "/Users/reader/Projects/sample";
const EXECUTABLE = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    if ((await stat(full)).isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function fixtureFiles() {
  const files = {};
  const images = [];
  for (const full of await walk(FIXTURES)) {
    const virtual = ROOT + "/" + relative(FIXTURES, full);
    if (/\.(md|txt|json|ts)$/.test(full)) files[virtual] = await readFile(full, "utf8");
    else images.push(virtual);
  }
  return { files, images };
}

// Remote images (README badges) are answered locally so runs are hermetic.
const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="20"><rect width="90" height="20" rx="3" fill="#555"/><rect x="44" width="46" height="20" rx="3" fill="#4c1"/><text x="6" y="14" fill="#fff" font-family="Verdana" font-size="11">badge</text></svg>`;

const mockSource = await readFile(join(here, "mock-tauri.js"), "utf8");
const { files, images } = await fixtureFiles();
files[ROOT + "/help.md"] = await readFile(join(here, "..", "src-tauri", "resources", "help.md"), "utf8");
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--font-render-hinting=none"] });
await mkdir(OUT, { recursive: true });

const results = [];
const failures = [];
const timings = {};

function check(name, condition, detail = "") {
  results.push({ name, ok: !!condition, detail });
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function timing(name, ms) {
  (timings[name] ??= []).push(Math.round(ms * 10) / 10);
}

async function open(scenario, { colorScheme = "light", width = 920, height = 820, reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion, deviceScaleFactor: 2 });
  const remote = [];
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "asset.localhost") {
        // Granted local files, as Tauri's asset protocol serves them.
        const path = decodeURIComponent(url.pathname.slice(1));
        if (!path.startsWith(ROOT + "/")) return route.fulfill({ status: 403 });
        try {
          const body = await readFile(join(FIXTURES, path.slice(ROOT.length + 1)));
          return route.fulfill({ status: 200, contentType: path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream", body });
        } catch {
          return route.fulfill({ status: 404 });
        }
      }
      remote.push(url.href);
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: BADGE });
    },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`${res.status()} ${res.url()}`);
  });
  // Any navigation away from the app is a failure (the Rust side blocks it too).
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && !frame.url().startsWith(base)) errors.push(`navigated to ${frame.url()}`);
  });
  await page.addInitScript({
    content: `window.__MOCK_FILES__ = ${JSON.stringify(files)};
window.__MOCK_IMAGES__ = ${JSON.stringify(images)};
window.__MOCK_SCENARIO__ = ${JSON.stringify(scenario)};
window.__CSP_VIOLATIONS__ = [];
addEventListener("securitypolicyviolation", (e) => window.__CSP_VIOLATIONS__.push(e.violatedDirective + " " + e.blockedURI));
window.__CLS__ = 0;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__CLS__ += e.value;
  }).observe({ type: "layout-shift", buffered: true });
} catch {}
${mockSource}`,
  });
  // Paint fake traffic lights so screenshots look like the real window.
  await page.addInitScript({
    content: `addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = ".toolbar::before{content:'';position:absolute;left:16px;top:16px;width:12px;height:12px;border-radius:6px;background:#ee6a5f;box-shadow:20px 0 #f5bd4f,40px 0 #61c454;z-index:9}";
      document.head.appendChild(s);
    });`,
  });
  const t0 = Date.now();
  await page.goto(base);
  await page.waitForFunction(() => window.__mock?.ready === true, null, { timeout: 15000 });
  const readyMs = Date.now() - t0;
  const finish = async (label) => {
    const csp = await page.evaluate(() => window.__CSP_VIOLATIONS__);
    check(`${label}: no CSP violations`, csp.length === 0, csp.join("\n"));
    check(`${label}: no console errors`, errors.length === 0, errors.join("\n"));
    await context.close();
  };
  return { page, context, errors, remote, readyMs, finish };
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

const doc = (p) => `${ROOT}/${p}`;
const menu = (page, action, arg = null) => page.evaluate(([a, g]) => window.__mock.emit("menu-action", { action: a, arg: g }), [action, arg]);
const calls = (page, name) => page.evaluate((n) => window.__mock.calls.filter(([c]) => c === n).map(([, a]) => a), name);
const activeTitle = (page) => page.textContent(".tab.is-active .tab-title");
const tabTitles = (page) => page.$$eval(".tab .tab-title", (els) => els.map((e) => e.textContent));
const frames = (page, n = 2) =>
  page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);
const activeScroller = ".tab-view.is-active .preview-scroll";
const activeBody = ".tab-view.is-active .markdown-body";

async function waitRendered(page, selector = `${activeBody} h1`) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await frames(page);
}

const scenarios = {
  async readme() {
    const s = await open({ pending: [doc("README.md")] });
    const { page } = s;
    await waitRendered(page);
    await page.waitForSelector(".mermaid-diagram svg", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    const committed = await page.evaluate(() => window.__mock.marks.find(([n]) => n.startsWith("render-committed"))?.[1]);
    timing("navigation start → README render committed", committed);
    check("readme: heading id", await page.$('h2[id="user-content-installation"]'));
    check("readme: alert", await page.$(".markdown-alert-note"));
    check("readme: task list", (await page.$$(".task-list-item-checkbox")).length === 3);
    check("readme: table align", await page.$('th[align="right"]'));
    check("readme: katex", await page.$(".katex"));
    check("readme: mermaid", await page.$(".mermaid-diagram svg"));
    check("readme: highlighted code", await page.$('.code-block pre:not(.plain) span[style*="--shiki-token"]'));
    const localImage = `img[src="http://asset.localhost/${encodeURIComponent(doc("docs/images/layout.svg"))}"]`;
    check("readme: local image", await page.$(localImage));
    check("readme: local image loaded", await page.$eval(localImage, (img) => img.complete && img.naturalWidth > 0));
    check("readme: image size reserved", await page.$(`${localImage}[width="640"][height="220"]`));
    check("readme: remote badge requested", s.remote.some((u) => u.includes("img.shields.io")));
    check("readme: footnote", await page.$("section.footnotes[data-footnotes] li"));
    check("readme: tab title", (await activeTitle(page))?.includes("README.md"));
    check("readme: document focused", await page.evaluate(() => document.activeElement?.classList.contains("preview-scroll")));
    const cls = await page.evaluate(() => window.__CLS__);
    check("readme: no layout shift", cls < 0.01, `CLS ${cls}`);
    await shot(page, "readme-light");

    // Copy button on a code block.
    await page.hover(".code-block");
    await page.click(".code-block .code-copy");
    check("readme: copy code", (await page.evaluate(() => window.__mock.clipboard))?.includes("pnpm install"));

    // Export ▸ HTML: one self-contained file.
    await menu(page, "export_html");
    await page.waitForFunction(() => window.__mock.exported, null, { timeout: 10000 });
    const exported = await page.evaluate(() => window.__mock.exported);
    check("readme: export name", exported.suggestedName === "README.html", exported.suggestedName);
    check("readme: export has no app or asset URLs", !/asset:|asset\.localhost|data-source-line|folio-slot/.test(exported.html));
    check("readme: export inlines images and math fonts", exported.html.includes("data:image/svg+xml") && /url\(["']?data:font\/woff2/.test(exported.html));
    check("readme: export keeps rendering", /class="katex"/.test(exported.html) && exported.html.includes("markdown-alert-note") && exported.html.includes("<svg"));

    // In-document anchor link, then Back.
    await page.click('a[href="#installation"]');
    await frames(page);
    const top = await page.$eval(activeScroller, (el) => el.scrollTop);
    check("readme: anchor link scrolls", top > 100, `scrollTop ${top}`);

    // External link → browser via Rust, never navigates the webview.
    await page.click('a[href="https://example.com"]');
    await frames(page);
    check("readme: external link opens in browser", (await calls(page, "open_external")).some((a) => a.url === "https://example.com"));

    // Relative Markdown link opens in the same tab with history.
    await page.click('a[href="docs/guide.md"]');
    await waitRendered(page, `${activeBody} h1#user-content-user-guide`);
    check("readme: relative link same tab", (await activeTitle(page)) === "guide.md" && (await tabTitles(page)).length === 1);
    check("readme: front matter hidden", !(await page.$(`${activeBody} .front-matter`)));
    await menu(page, "go_back");
    await waitRendered(page, `${activeBody} h2#user-content-installation`);
    check("readme: back returns", (await activeTitle(page)) === "README.md");
    await menu(page, "go_forward");
    await waitRendered(page, `${activeBody} h1#user-content-user-guide`);
    check("readme: forward", (await activeTitle(page)) === "guide.md");

    // Link to a text file opens it in Code view.
    await page.click('a[href="../notes.txt"]');
    await page.waitForSelector(".tab-view.is-active .cm-editor", { timeout: 10000 });
    check("readme: text link opens code view", (await activeTitle(page)) === "notes.txt");
    const segDisabled = await page.$$eval(".segmented[aria-label='View mode'] button", (b) => b.map((x) => x.disabled));
    check("readme: text file is code-only", segDisabled[0] && !segDisabled[1] && segDisabled[2], JSON.stringify(segDisabled));
    await s.finish("readme");
  },

  async dark() {
    const s = await open({ pending: [doc("README.md")] }, { colorScheme: "dark" });
    const { page } = s;
    await waitRendered(page);
    await page.waitForSelector(".mermaid-diagram svg", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    const bg = await page.$eval(activeScroller, (el) => getComputedStyle(el).backgroundColor);
    check("dark: surface color", bg === "rgb(38, 38, 36)", bg);
    await shot(page, "readme-dark");
    await page.evaluate((sel) => document.querySelector(sel).scrollTo(0, 900), activeScroller);
    await frames(page);
    await shot(page, "readme-dark-scrolled");
    await s.finish("dark");
  },

  async themes() {
    for (const theme of ["github", "paper"]) {
      for (const scheme of ["light", "dark"]) {
        const s = await open({ pending: [doc("README.md")], settings: { theme } }, { colorScheme: scheme });
        await waitRendered(s.page);
        await s.page.waitForTimeout(300);
        await shot(s.page, `theme-${theme}-${scheme}`);
        check(`themes: ${theme} ${scheme} applied`, (await s.page.evaluate(() => document.documentElement.dataset.theme)) === theme);
        await s.finish(`themes ${theme} ${scheme}`);
      }
    }
    // Live theme switch (settings-changed from Rust).
    const s = await open({ pending: [doc("README.md")] });
    await waitRendered(s.page);
    await s.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("update_settings", { patch: { theme: "github", readingWidth: "wide", fontFamily: "sans" } }));
    await s.page.waitForFunction(() => document.documentElement.dataset.theme === "github");
    const width = await s.page.$eval(activeBody, (el) => el.getBoundingClientRect().width);
    check("themes: live switch + wide width", width > 700, `width ${width}`);
    await s.finish("themes live");
  },

  async tabs() {
    const s = await open({ pending: [doc("README.md"), doc("api/README.md"), doc("docs/guide.md")] });
    const { page } = s;
    await waitRendered(page);
    const titles = await tabTitles(page);
    check("tabs: three tabs", titles.length === 3, JSON.stringify(titles));
    check("tabs: disambiguation", titles[0] === "README.md — sample" && titles[1] === "README.md — api", JSON.stringify(titles));
    check("tabs: last opened is active", (await activeTitle(page)) === "guide.md");
    await shot(page, "tabs");

    // Dedupe: opening an open file focuses its tab.
    await page.evaluate((p) => window.__mock.open([p]), doc("README.md"));
    await frames(page, 3);
    check("tabs: dedupe", (await tabTitles(page)).length === 3 && (await activeTitle(page)).startsWith("README.md — sample"));

    // Switching: click, ⌘2, ⌃Tab.
    for (let i = 0; i < 5; i++) {
      const ms = await page.evaluate(async (index) => {
        const tab = document.querySelectorAll(".tab")[index];
        const t0 = performance.now();
        tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, isPrimary: true }));
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));
        // The frame that shows the switch: rAF runs before its paint, the
        // task queued from it runs after.
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        return performance.now() - t0;
      }, i % 3);
      timing("tab switch, mounted tab (click → painted)", ms);
    }
    // Scroll positions survive switching away and back.
    await page.click(".tab >> nth=0");
    await page.evaluate((sel) => document.querySelector(sel).scrollTo(0, 700), activeScroller);
    await page.waitForTimeout(200);
    await page.click(".tab >> nth=2");
    await frames(page);
    await page.click(".tab >> nth=0");
    await frames(page);
    const kept = await page.$eval(activeScroller, (el) => el.scrollTop);
    check("tabs: scroll position kept across switches", Math.abs(kept - 700) < 2, `scrollTop ${kept}`);
    await page.keyboard.press("Meta+2");
    await frames(page);
    check("tabs: ⌘2", (await activeTitle(page)).startsWith("README.md — api"));
    await page.keyboard.press("Control+Tab");
    await frames(page);
    check("tabs: ⌃⇥", (await activeTitle(page)) === "guide.md");
    await page.keyboard.press("Meta+9");
    await frames(page);
    check("tabs: ⌘9 last tab", (await activeTitle(page)) === "guide.md");

    // Registry sync.
    await page.waitForTimeout(100);
    const registry = await page.evaluate(() => window.__mock.registry());
    check("tabs: registry synced", registry?.tabs?.length === 3 && registry.menu.tabCount === 3);

    // Reorder by dragging the first tab past the second.
    const boxes = await page.$$eval(".tab", (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    await page.mouse.move(boxes[0].x + boxes[0].width / 2, boxes[0].y + boxes[0].height / 2);
    await page.mouse.down();
    await page.mouse.move(boxes[1].x + boxes[1].width * 0.9, boxes[0].y + 10, { steps: 8 });
    await page.mouse.up();
    await frames(page);
    const reordered = await tabTitles(page);
    check("tabs: drag reorder", reordered[0].startsWith("README.md — api") && reordered[1].startsWith("README.md — sample"), JSON.stringify(reordered));

    // Context menu → native popup with the expected items.
    await page.click(".tab >> nth=2", { button: "right" });
    const menuItems = await page.evaluate(() => window.__mock.lastMenu.items.map((i) => i.label ?? "—"));
    check(
      "tabs: context menu items",
      JSON.stringify(menuItems) ===
        JSON.stringify(["Close Tab", "Close Other Tabs", "Close Tabs to the Right", "—", "Copy Path", "Reveal in Finder", "Open in Editor", "—", "Move to New Window"]),
      JSON.stringify(menuItems),
    );
    // Choose "Copy Path".
    await page.evaluate(() => {
      const m = window.__mock.lastMenu;
      window.__mock.emit("context-menu", { token: m.token, item: m.items.find((i) => i.label === "Copy Path").id });
    });
    await frames(page);
    check("tabs: copy path", (await page.evaluate(() => window.__mock.clipboard)) === doc("docs/guide.md"));

    // Close with the button, middle-click, reopen.
    await page.hover(".tab >> nth=2");
    await page.click(".tab >> nth=2 >> .tab-close");
    await frames(page);
    check("tabs: close button", (await tabTitles(page)).length === 2);
    await page.click(".tab >> nth=1", { button: "middle" });
    await frames(page);
    check("tabs: middle-click close", (await tabTitles(page)).length === 1);
    await menu(page, "reopen_closed_tab");
    await frames(page, 3);
    check("tabs: reopen closed tab", (await tabTitles(page)).length === 2);
    const titlesAfter = await tabTitles(page);
    check("tabs: reopened tab is the last closed", JSON.stringify(titlesAfter) === JSON.stringify(["README.md — api", "README.md — sample"]), JSON.stringify(titlesAfter));
    await page.click(".tab >> nth=0", { button: "middle" });
    await frames(page);
    check("tabs: lone README drops disambiguation", JSON.stringify(await tabTitles(page)) === JSON.stringify(["README.md"]));
    await menu(page, "reopen_closed_tab");
    await frames(page, 3);

    // Drop two files onto the tab bar between the tabs.
    const bar = await page.$eval(".tab >> nth=0", (e) => e.getBoundingClientRect().toJSON()).catch(() => null);
    const first = await page.$$eval(".tab", (els) => els[0].getBoundingClientRect().toJSON());
    await page.evaluate(
      ([x, y, a, b]) => {
        const scale = devicePixelRatio;
        window.__mock.emit("tauri://drag-over", { paths: [a, b], position: { x: x * scale, y: y * scale } });
        window.__mock.emit("tauri://drag-drop", { paths: [a, b], position: { x: x * scale, y: y * scale } });
      },
      [first.x + first.width * 0.9, first.y + first.height / 2, doc("long.md"), doc("security.md")],
    );
    await page.waitForTimeout(100);
    const dropped = await calls(page, "open_dropped");
    check("tabs: tab-bar drop inserts at position", dropped.length === 1 && dropped[0].insertAt === 1, JSON.stringify(dropped));
    await frames(page, 3);
    const afterDrop = await tabTitles(page);
    check("tabs: dropped files open at position", afterDrop[1] === "long.md" && afterDrop[2] === "security.md", JSON.stringify(afterDrop));
    void bar;
    await s.finish("tabs");
  },

  async manytabs() {
    const names = ["README.md", "api/README.md", "docs/guide.md", "long.md", "security.md"];
    const extra = Array.from({ length: 5 }, (_, i) => `extra-${i + 1}.md`);
    const s = await open({ pending: names.map(doc) });
    const { page } = s;
    await page.evaluate(
      ([paths, text]) => {
        for (const p of paths) window.__mock.files[p] = text.replace("TITLE", p.split("/").pop());
      },
      [extra.map(doc), "# TITLE\n\n" + "Some paragraph text for this tab.\n\n".repeat(40)],
    );
    await page.evaluate((paths) => window.__mock.open(paths), extra.map(doc));
    await page.waitForFunction(() => document.querySelectorAll(".tab").length === 10);
    await waitRendered(page);
    // Visit every tab so each has rendered once.
    for (let i = 0; i < 10; i++) {
      await page.click(`.tab >> nth=${i}`);
      await page.waitForSelector(`${activeBody} h1`, { timeout: 15000 });
    }
    check("manytabs: overflow chevron", await page.$(".tab-overflow"));
    const mounted = await page.$$eval(".tab-view", (els) => els.length);
    check("manytabs: only recent tabs mounted", mounted <= 6, `mounted ${mounted}`);
    await shot(page, "manytabs");
    // Switch to the oldest tab (not mounted → rebuilt from cached HTML).
    for (let round = 0; round < 3; round++) {
      for (const index of [0, 1, 2]) {
        const ms = await page.evaluate(async (i) => {
          const tab = document.querySelectorAll(".tab")[i];
          const t0 = performance.now();
          tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, isPrimary: true }));
          window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));
          for (let n = 0; n < 60; n++) {
            await new Promise((r) => requestAnimationFrame(r));
            const body = document.querySelector(".tab-view.is-active .markdown-body");
            if (body && body.childElementCount > 0) break;
          }
          await new Promise((r) => setTimeout(r, 0));
          return performance.now() - t0;
        }, index);
        timing("tab switch, evicted tab rebuilt from cache (click → painted)", ms);
      }
      // Push the first three out of the mounted set again.
      for (const i of [9, 8, 7, 6, 5]) await page.click(`.tab >> nth=${i}`);
      await frames(page);
    }
    // Overflow menu lists every tab.
    await page.click(".tab-overflow");
    const items = await page.evaluate(() => window.__mock.lastMenu.items.length);
    check("manytabs: overflow menu lists tabs", items === 10, `items ${items}`);
    await s.finish("manytabs");
  },

  async views() {
    const s = await open({ pending: [doc("README.md")] });
    const { page } = s;
    await waitRendered(page);

    // ⌘/ → Code view.
    await menu(page, "toggle_code");
    await page.waitForSelector(".tab-view.is-active .cm-editor .cm-lineNumbers", { timeout: 10000 });
    await frames(page, 3);
    check("views: code view", (await page.$eval(".tab-view.is-active .code-pane-host", (el) => getComputedStyle(el).display)) !== "none");
    check("views: code highlighted", await page.$(".tab-view.is-active .cm-content .cm-line span[class]"));
    check("views: read-only", (await page.$eval(".tab-view.is-active .cm-content", (el) => el.getAttribute("aria-readonly"))) === "true");
    await shot(page, "code-view");
    await page.keyboard.type("zzz");
    const text = await page.$eval(".tab-view.is-active .cm-content", (el) => el.textContent);
    check("views: typing does not edit", !text.includes("zzz"));

    // ⌘\ → Split with scroll sync.
    await menu(page, "toggle_split");
    await page.waitForSelector(".tab-view.is-active .split .split-divider");
    await frames(page, 3);
    check("views: split panes", (await page.$$(".tab-view.is-active .split .split-pane")).length === 2);
    await page.hover(activeScroller);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);
    const codeTop = await page.$eval(".tab-view.is-active .cm-scroller", (el) => el.scrollTop);
    check("views: preview scroll syncs code", codeTop > 200, `code scrollTop ${codeTop}`);
    await shot(page, "split-view");

    // Drag the divider; the ratio is kept per tab.
    const divider = await page.$eval(".tab-view.is-active .split-divider", (e) => e.getBoundingClientRect().toJSON());
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 200);
    await page.mouse.down();
    await page.mouse.move(divider.x - 150, divider.y + 200, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const ratio = await page.evaluate(() => window.__mock.registry()?.tabs?.[0]?.splitRatio);
    check("views: divider drag changes ratio", ratio && ratio < 0.45, `ratio ${ratio}`);

    // Back to preview; double-click a paragraph → its line in Code view.
    await menu(page, "view_preview");
    await frames(page, 3);
    const para = await page.$(`${activeBody} p[data-source-line]`);
    const line = Number(await para.getAttribute("data-source-line"));
    await para.dblclick();
    await page.waitForSelector(".tab-view.is-active .cm-editor");
    await page.waitForTimeout(300);
    const selectedLine = await page.evaluate(() => {
      const sel = document.querySelector(".tab-view.is-active .cm-activeLine");
      return sel ? sel.textContent : null;
    });
    const sourceLine = files[doc("README.md")].split("\n")[line];
    check("views: double-click jumps to source line", selectedLine === sourceLine, `${JSON.stringify(selectedLine)} vs ${JSON.stringify(sourceLine)}`);
    await s.finish("views");
  },

  async sidebar() {
    const s = await open({ pending: [{ path: ROOT }] });
    const { page } = s;
    await waitRendered(page);
    await page.waitForSelector(".sidebar .row");
    check("sidebar: folder opens README", (await activeTitle(page)) === "README.md");
    const rows = await page.$$eval(".sidebar [role=tree] .row-label", (els) => els.map((e) => e.textContent));
    check("sidebar: files tree", rows.includes("docs") && rows.includes("README.md") && !rows.includes("notes.txt"), JSON.stringify(rows));
    await shot(page, "sidebar-files");
    // Expand docs and open guide.md.
    await page.click('.sidebar .row:has(.row-label:text-is("docs"))');
    await page.click('.sidebar .row:has(.row-label:text-is("guide.md"))');
    await page.waitForFunction(() => document.querySelector(".tab.is-active .tab-title")?.textContent === "guide.md");
    check("sidebar: file opens in a tab", (await tabTitles(page)).length === 2);
    // Outline pane.
    await menu(page, "sidebar_outline");
    await page.waitForSelector(".sidebar .outline-item");
    const outline = await page.$$eval(".sidebar .outline-item .row-label", (els) => els.map((e) => e.textContent));
    check("sidebar: outline", outline[0] === "User Guide" && outline.includes("Keyboard"), JSON.stringify(outline));
    await page.click('.sidebar .outline-item:has(.row-label:text-is("Keyboard"))');
    await frames(page, 3);
    check("sidebar: clicked heading is current", (await page.textContent(".sidebar .outline-item.is-current .row-label")) === "Keyboard");
    const top = await page.$eval(activeScroller, (el) => el.scrollTop);
    check("sidebar: outline click scrolls", top > 50, `scrollTop ${top}`);
    await shot(page, "sidebar-outline");
    // ⌃⌘S hides it.
    await menu(page, "toggle_sidebar");
    await frames(page);
    check("sidebar: toggle hides", !(await page.$(".sidebar")));
    await s.finish("sidebar");
  },

  async find() {
    const s = await open({ pending: [doc("README.md")] });
    const { page } = s;
    await waitRendered(page);
    await menu(page, "find");
    await page.waitForSelector(".findbar input");
    await page.keyboard.type("folio");
    await page.waitForTimeout(100);
    const status = await page.textContent(".find-count");
    check("find: count", /^1 of \d+$/.test(status ?? ""), status);
    const total = Number(status.split(" of ")[1]);
    check("find: case-insensitive matches", total >= 2, status);
    await page.keyboard.press("Enter");
    check("find: next", (await page.textContent(".find-count")) === `2 of ${total}`);
    await page.keyboard.press("Shift+Enter");
    check("find: previous", (await page.textContent(".find-count")) === `1 of ${total}`);
    await menu(page, "find_next");
    check("find: ⌘G", (await page.textContent(".find-count")) === `2 of ${total}`);
    await shot(page, "find");
    await page.fill(".findbar input", "zebra-not-here");
    check("find: not found", (await page.textContent(".find-count")) === "Not found");
    // Code view search uses the same bar.
    await page.fill(".findbar input", "pnpm");
    await menu(page, "toggle_code");
    await page.waitForSelector(".tab-view.is-active .cm-editor");
    await page.waitForTimeout(200);
    await menu(page, "find");
    await page.waitForTimeout(100);
    const codeStatus = await page.textContent(".find-count");
    check("find: code view search", /^\d+ of \d+$/.test(codeStatus ?? ""), codeStatus);
    await page.keyboard.press("Escape");
    await frames(page);
    check("find: escape closes", !(await page.$(".findbar")));
    await s.finish("find");
  },

  async quickopen() {
    const s = await open({ pending: [{ path: ROOT }], recents: [{ path: doc("long.md"), name: "long.md", isFolder: false }] });
    const { page } = s;
    await waitRendered(page);
    await page.waitForSelector(".sidebar .row");
    await menu(page, "open_quickly");
    await page.waitForSelector(".quick-open input");
    await page.keyboard.type("gde");
    await page.waitForTimeout(50);
    const first = await page.textContent(".quick-open-row.is-selected .name");
    check("quickopen: fuzzy match", first === "guide.md", first);
    await shot(page, "quickopen");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".tab.is-active .tab-title")?.textContent === "guide.md");
    check("quickopen: opens file", !(await page.$(".quick-open")));
    await s.finish("quickopen");
  },

  async welcome() {
    for (const scheme of ["light", "dark"]) {
      const s = await open(
        {
          pending: [],
          recents: [
            { path: doc("README.md"), name: "README.md", isFolder: false },
            { path: ROOT + "/docs", name: "docs", isFolder: true },
          ],
        },
        { colorScheme: scheme },
      );
      const { page } = s;
      await page.waitForSelector(".welcome .welcome-recents .row");
      await frames(page);
      await shot(page, `welcome-${scheme}`);
      if (scheme === "light") {
        check("welcome: shown with recents", (await page.$$(".welcome .welcome-recents .row")).length === 2);
        check("welcome: view mode disabled", await page.$eval(".segmented[aria-label='View mode'] button", (b) => b.disabled));
        await page.click(".welcome .welcome-recents .row >> nth=0");
        await waitRendered(page);
        check("welcome: recent opens into the same tab", (await tabTitles(page)).length === 1 && (await activeTitle(page)) === "README.md");
        await menu(page, "new_tab");
        await page.waitForSelector(".tab-view.is-active .welcome");
        check("welcome: ⌘T new tab shows welcome", (await tabTitles(page)).length === 2);
      }
      await s.finish(`welcome ${scheme}`);
    }
  },

  async errors() {
    const s = await open({ pending: [doc("missing.md")] });
    const { page } = s;
    await page.waitForSelector(".error-state");
    const heading = await page.textContent(".error-state h1");
    check("errors: calm not-found state", heading.includes("can’t find") && heading.includes("missing.md"), heading);
    await shot(page, "error-missing");
    // A broken relative link shows a banner, not an error page.
    await page.evaluate((p) => {
      window.__mock.files[p] = "# Links\n\n[nowhere](nope.md)\n";
    }, doc("links.md"));
    await page.evaluate((p) => window.__mock.open([p]), doc("links.md"));
    await waitRendered(page);
    await page.click('a[href="nope.md"]');
    await page.waitForSelector(".banner");
    check("errors: missing link banner", (await page.textContent(".banner")).includes("doesn’t exist"));
    await s.finish("errors");
  },

  async large() {
    const s = await open({ pending: [doc("long.md")], largeBytes: 1000 });
    const { page } = s;
    await page.waitForSelector(".tab-view.is-active .cm-editor");
    await page.waitForSelector(".banner");
    check("large: opens as source with offer", (await page.textContent(".banner")).includes("Render Anyway"));
    await shot(page, "large-file");
    await page.click('.banner button:has-text("Render Anyway")');
    await waitRendered(page);
    check("large: renders on request", await page.$(`${activeBody} h1`));
    await s.finish("large");
  },

  async security() {
    const s = await open({ pending: [doc("security.md")] });
    const { page } = s;
    await waitRendered(page);
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => {
      const body = document.querySelector(".tab-view.is-active .markdown-body");
      const hrefs = Array.from(body.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
      const handlers = Array.from(body.querySelectorAll("*")).flatMap((el) => Array.from(el.attributes).filter((a) => /^on/i.test(a.name)).map((a) => a.name));
      return {
        pwned: window.__pwned ?? null,
        forbidden: Array.from(body.querySelectorAll("script, iframe, form, input, object, embed, meta, base, style, link")).map((e) => e.tagName),
        styled: Array.from(body.querySelectorAll("[style]")).map((e) => e.tagName),
        hrefs,
        handlers,
        bodyVisible: getComputedStyle(document.body).display !== "none",
        centered: !!body.querySelector('p[align="center"]'),
        allowed: ["details", "summary", "kbd", "sub", "sup", "picture"].filter((t) => body.querySelector(t)),
        clobbered: typeof document.getElementById !== "function",
      };
    });
    check("security: no script ran", state.pwned === null, String(state.pwned));
    check("security: dangerous elements removed", state.forbidden.length === 0, state.forbidden.join(","));
    check("security: no event handlers", state.handlers.length === 0, state.handlers.join(","));
    check("security: no style attributes", state.styled.length === 0, state.styled.join(","));
    check("security: no javascript: hrefs", !state.hrefs.some((h) => /^\s*javascript:/i.test(h)), JSON.stringify(state.hrefs));
    check("security: page still visible", state.bodyVisible);
    check("security: safe subset kept", state.centered && state.allowed.length === 6, JSON.stringify(state.allowed));
    check("security: no DOM clobbering", !state.clobbered);
    // Clicking hostile links never navigates and never reaches the browser.
    for (const text of ["javascript link", "custom scheme link"]) {
      const link = await page.$(`a:has-text("${text}")`);
      if (link) await link.click();
    }
    await page.click('a:has-text("new window link")');
    await page.waitForTimeout(200);
    const external = await calls(page, "open_external");
    check("security: only http(s) reaches the browser", external.length === 1 && external[0].url === "https://example.com/", JSON.stringify(external));
    check("security: still on the app page", page.url().startsWith(base));
    await shot(page, "security");
    await s.finish("security");
  },

  async reload() {
    const s = await open({ pending: [doc("long.md")] });
    const { page } = s;
    await waitRendered(page);
    await page.evaluate((sel) => document.querySelector(sel).scrollTo(0, 6000), activeScroller);
    await page.waitForTimeout(300);
    const before = await page.evaluate((sel) => {
      const scroller = document.querySelector(sel);
      const top = scroller.getBoundingClientRect().top;
      const blocks = Array.from(scroller.querySelectorAll(".markdown-body > [data-source-line]"));
      const first = blocks.find((b) => b.getBoundingClientRect().bottom > top + 1);
      first.__marker = true;
      return { text: first.textContent.slice(0, 80), offset: first.getBoundingClientRect().top - top, scrollTop: scroller.scrollTop };
    }, activeScroller);
    // Insert new paragraphs at the top and edit one block in view.
    const original = files[doc("long.md")];
    const lines = original.split("\n");
    const inserted = ["", "## Inserted section", "", "New text at the top.", "", "Another new paragraph.", ""];
    const changed = [lines[0], ...inserted, ...lines.slice(1)].join("\n");
    const t0 = await page.evaluate(() => performance.now());
    await page.evaluate(([p, text]) => window.__mock.change(p, text), [doc("long.md"), changed]);
    await page.waitForSelector(`${activeBody} #user-content-inserted-section`, { timeout: 10000 });
    await frames(page);
    const t1 = await page.evaluate(() => performance.now());
    timing("live reload (change event → re-rendered)", t1 - t0);
    const after = await page.evaluate((sel) => {
      const scroller = document.querySelector(sel);
      const top = scroller.getBoundingClientRect().top;
      const blocks = Array.from(scroller.querySelectorAll(".markdown-body > [data-source-line]"));
      const first = blocks.find((b) => b.getBoundingClientRect().bottom > top + 1);
      return {
        text: first.textContent.slice(0, 80),
        offset: first.getBoundingClientRect().top - top,
        kept: first.__marker === true && first.isConnected,
        tinted: scroller.querySelectorAll(".block-changed").length,
        scrollTop: scroller.scrollTop,
      };
    }, activeScroller);
    check("reload: position anchored", after.text === before.text && Math.abs(after.offset - before.offset) < 2, JSON.stringify({ before, after }));
    check("reload: unchanged blocks keep their DOM", after.kept);
    check("reload: changed blocks tinted", after.tinted >= 2, `tinted ${after.tinted}`);
    // Deleted on disk → banner; last version stays.
    await page.evaluate((p) => window.__mock.remove(p), doc("long.md"));
    await page.waitForSelector(".banner");
    check("reload: removed banner", (await page.textContent(".banner")).includes("moved or deleted"));
    check("reload: content kept after removal", await page.$(`${activeBody} #user-content-inserted-section`));
    await shot(page, "removed-banner");
    await s.finish("reload");

    // Reduce Motion: no tint animation.
    const r = await open({ pending: [doc("README.md")] }, { reducedMotion: "reduce" });
    await waitRendered(r.page);
    await r.page.evaluate(([p, text]) => window.__mock.change(p, text), [doc("README.md"), files[doc("README.md")] + "\n\nAppended paragraph.\n"]);
    await r.page.waitForSelector(`${activeBody} p:has-text("Appended paragraph.")`);
    const animation = await r.page.evaluate(() => {
      const el = document.querySelector(".block-changed");
      return el ? getComputedStyle(el).animationName : "none";
    });
    check("reload: reduce motion disables tint", animation === "none", animation);
    await r.finish("reload reduced motion");
  },

  async restore() {
    const s = await open({
      pending: [],
      init: {
        tabs: [
          { id: "t1", path: doc("README.md"), title: "README.md", isStdin: false, viewMode: "preview", kind: "markdown", anchor: 0, splitRatio: 0.5, history: { back: [], forward: [] } },
          { id: "t2", path: doc("long.md"), title: "long.md", isStdin: false, viewMode: "split", kind: "markdown", anchor: 300, splitRatio: 0.4, history: { back: [], forward: [] } },
        ],
        activeTabId: "t2",
        folder: null,
        sidebar: null,
        notices: ["“old.md” couldn’t be restored because it no longer exists."],
      },
    });
    const { page } = s;
    await page.waitForSelector(".tab-view.is-active .split");
    await page.waitForSelector(`${activeBody} h1`);
    await page.waitForTimeout(400);
    check("restore: tabs restored", (await tabTitles(page)).join(",") === "README.md,long.md");
    check("restore: active tab and mode", (await activeTitle(page)) === "long.md");
    const line = await page.evaluate(() => {
      const scroller = document.querySelector(".tab-view.is-active .preview-scroll");
      const top = scroller.getBoundingClientRect().top;
      const blocks = Array.from(scroller.querySelectorAll(".markdown-body > [data-source-line]"));
      const first = blocks.find((b) => b.getBoundingClientRect().bottom > top + 1);
      return Number(first.dataset.sourceLine);
    });
    check("restore: reading position", Math.abs(line - 300) < 12, `top line ${line}`);
    check("restore: missing-file notice", (await page.textContent(".banner")).includes("couldn’t be restored"));
    await shot(page, "restore");
    await s.finish("restore");
  },

  async settings() {
    for (const scheme of ["light", "dark"]) {
      const s = await open({ label: "settings", kind: "settings" }, { colorScheme: scheme, width: 620, height: 520 });
      const { page } = s;
      await page.waitForSelector(".settings-toolbar button");
      const panes = await page.$$eval(".settings-toolbar button", (els) => els.map((e) => e.textContent.trim()));
      if (scheme === "light") check("settings: panes", JSON.stringify(panes) === JSON.stringify(["General", "Appearance", "Reading", "Advanced"]), JSON.stringify(panes));
      for (const [i, name] of panes.entries()) {
        await page.click(`.settings-toolbar button >> nth=${i}`);
        await page.waitForTimeout(150);
        await shot(page, `settings-${name.toLowerCase()}-${scheme}`);
      }
      if (scheme === "light") {
        await page.click('.settings-toolbar button:has-text("Appearance")');
        await page.waitForTimeout(100);
        const before = (await calls(page, "update_settings")).length;
        await page.selectOption(".settings select >> nth=0", "github");
        await page.waitForTimeout(100);
        const updates = await calls(page, "update_settings");
        check("settings: theme applies live", updates.length > before && updates.at(-1).patch.theme === "github", JSON.stringify(updates.at(-1)));
      }
      await s.finish(`settings ${scheme}`);
    }
  },

  async print() {
    const s = await open({ pending: [doc("README.md"), doc("docs/guide.md")] });
    const { page } = s;
    await waitRendered(page);
    await page.click(".tab >> nth=0");
    await waitRendered(page);
    await page.waitForSelector(".mermaid-diagram svg", { timeout: 15000 }).catch(() => {});
    await page.emulateMedia({ media: "print" });
    await frames(page);
    const state = await page.evaluate(() => ({
      toolbar: getComputedStyle(document.querySelector(".toolbar")).display,
      background: getComputedStyle(document.body).backgroundColor,
      visibleDocs: [...document.querySelectorAll(".tab-view")].filter((t) => getComputedStyle(t).display !== "none").length,
      height: document.documentElement.scrollHeight,
    }));
    check("print: no chrome", state.toolbar === "none");
    check("print: white paper", state.background === "rgb(255, 255, 255)", state.background);
    check("print: only the active document", state.visibleDocs === 1, `visible ${state.visibleDocs}`);
    check("print: whole document flows (no inner scroller)", state.height > 1500, `height ${state.height}`);
    await page.screenshot({ path: join(OUT, "print.png"), fullPage: true });
    await s.finish("print");
  },

  async help() {
    const s = await open({ pending: [doc("help.md")] });
    const { page } = s;
    await waitRendered(page);
    await page.waitForTimeout(800);
    check("help: renders tables and alerts", (await page.$$(`${activeBody} table`)).length >= 3 && (await page.$(`${activeBody} .markdown-alert-tip`)));
    check("help: math and emoji", (await page.$(`${activeBody} .katex`)) && (await page.textContent(activeBody)).includes("✨"));
    await shot(page, "help");
    await page.evaluate((sel) => document.querySelector(sel).scrollTo(0, 2400), activeScroller);
    await frames(page);
    await shot(page, "help-scrolled");
    await s.finish("help");
  },

  async zoom() {
    const s = await open({ pending: [doc("README.md")] });
    const { page } = s;
    await waitRendered(page);
    const size = () => page.$eval(`${activeBody} p`, (p) => parseFloat(getComputedStyle(p).fontSize));
    const before = await size();
    await page.keyboard.press("Meta+=");
    await page.waitForFunction((b) => parseFloat(getComputedStyle(document.querySelector(".tab-view.is-active .markdown-body p")).fontSize) > b, before);
    const after = await size();
    check("zoom: text zoom reflows", after > before, `${before} → ${after}`);
    const scrollWidth = await page.$eval(activeScroller, (el) => el.scrollWidth - el.clientWidth);
    check("zoom: no horizontal scroll", scrollWidth <= 0, `overflow ${scrollWidth}`);
    await s.finish("zoom");
  },
};

const wanted = process.argv.slice(2);
for (const [name, run] of Object.entries(scenarios)) {
  if (wanted.length && !wanted.includes(name)) continue;
  try {
    await run();
  } catch (err) {
    check(`${name}: ran`, false, String(err?.stack ?? err));
  }
}

await browser.close();
server.close();
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok || !r.detail ? "" : `\n    ${r.detail.split("\n").join("\n    ")}`}`);
const summary = Object.entries(timings).map(([name, values]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { name, runs: values.length, median, max: sorted.at(-1), values };
});
if (summary.length) {
  console.log("\nTimings (Chromium, mocked IPC; not a substitute for the macOS measurements):");
  for (const t of summary) console.log(`  ${t.name}: median ${t.median} ms, max ${t.max} ms (${t.runs} runs)`);
}
await writeFile(join(OUT, "results.json"), JSON.stringify({ results, timings: summary }, null, 2));
console.log(`\n${results.length - failures.length}/${results.length} checks passed. Screenshots: ${relative(process.cwd(), OUT)}`);
process.exit(failures.length ? 1 : 0);
