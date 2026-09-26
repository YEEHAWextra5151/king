// Drives the production frontend (dist/) in Chromium with a mocked Tauri
// runtime: functional checks plus screenshots for visual review.
//
//   pnpm build && node e2e/run.mjs [scenario …]
import { chromium } from "@playwright/test";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
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

const mockSource = await readFile(join(here, "mock-tauri.js"), "utf8");
const { files, images } = await fixtureFiles();
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--font-render-hinting=none"] });
await mkdir(OUT, { recursive: true });

const results = [];
const failures = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: !!condition, detail });
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

async function open(scenario, { colorScheme = "light", width = 920, height = 820 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.addInitScript({
    content: `window.__MOCK_FILES__ = ${JSON.stringify(files)};
window.__MOCK_IMAGES__ = ${JSON.stringify(images)};
window.__MOCK_SCENARIO__ = ${JSON.stringify(scenario)};
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
  await page.goto(base);
  await page.waitForFunction(() => window.__mock?.ready === true, null, { timeout: 15000 });
  return { page, context, errors };
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

const doc = (p) => `${ROOT}/${p}`;

const scenarios = {
  async readme() {
    const { page, context, errors } = await open({ pending: [doc("README.md")] });
    await page.waitForSelector(".markdown-body h1");
    await page.waitForSelector(".mermaid-diagram svg", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    check("readme: heading id", await page.$('h2[id="user-content-installation"]'));
    check("readme: alert", await page.$(".markdown-alert-note"));
    check("readme: task list", (await page.$$(".task-list-item-checkbox")).length === 3);
    check("readme: table align", await page.$('th[align="right"]'));
    check("readme: katex", await page.$(".katex"));
    check("readme: mermaid", await page.$(".mermaid-diagram svg"));
    check("readme: highlighted code", await page.$('.code-block pre:not(.plain) span[style*="--shiki-token"]'));
    check("readme: local image", await page.$('img[src^="/__fixtures__/docs/images/layout.svg"]'));
    check("readme: tab title", (await page.textContent(".tab.is-active .tab-title"))?.includes("README.md"));
    await shot(page, "readme-light");
    await page.evaluate(() => document.querySelector(".preview-scroll").scrollTo(0, 900));
    await page.waitForTimeout(200);
    await shot(page, "readme-light-scrolled");
    check("readme: no console errors", errors.length === 0, errors.join("\n"));
    await context.close();
  },

  async dark() {
    const { page, context, errors } = await open({ pending: [doc("README.md")] }, { colorScheme: "dark" });
    await page.waitForSelector(".markdown-body h1");
    await page.waitForSelector(".mermaid-diagram svg", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, "readme-dark");
    await page.evaluate(() => document.querySelector(".preview-scroll").scrollTo(0, 900));
    await page.waitForTimeout(200);
    await shot(page, "readme-dark-scrolled");
    check("dark: no console errors", errors.length === 0, errors.join("\n"));
    await context.close();
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
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok || !r.detail ? "" : `\n    ${r.detail}`}`);
console.log(`\n${results.length - failures.length}/${results.length} checks passed. Screenshots: ${relative(process.cwd(), OUT)}`);
process.exit(failures.length ? 1 : 0);
