// Cold-start breakdown of the production bundle in Chromium (mocked IPC):
// when the worker starts, when the first render is requested and returned,
// and when the document is committed and fully highlighted.
//
//   pnpm build && node e2e/startup.mjs [runs]
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { serve } from "./serve.mjs";

const RUNS = Number(process.argv[2] ?? 7);
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const mock = await readFile(new URL("./mock-tauri.js", import.meta.url), "utf8");
const readme = await readFile(new URL("./fixtures/project/README.md", import.meta.url), "utf8");

// Records worker creation, the first render request, and its response.
const probe = `
  window.__T = {};
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      __T.created = performance.now();
      const post = this.postMessage.bind(this);
      this.postMessage = (m) => { if (m.type === "render" && !__T.posted) __T.posted = performance.now(); post(m); };
      this.addEventListener("message", (e) => {
        if (e.data.type === "rendered" && !__T.received) {
          __T.received = performance.now();
          __T.worker = e.data.output.timings;
        }
      });
    }
  };`;

const rows = [];
for (let run = 0; run < RUNS; run++) {
  const context = await browser.newContext({ viewport: { width: 920, height: 820 } });
  await context.route((u) => u.hostname !== "127.0.0.1", (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));
  const page = await context.newPage();
  await page.addInitScript({ content: probe });
  await page.addInitScript({
    content: `window.__MOCK_FILES__ = ${JSON.stringify({ "/p/README.md": readme })};
window.__MOCK_SCENARIO__ = { root: "/p", pending: ["/p/README.md"] };
${mock}`,
  });
  await page.goto(base);
  await page.waitForFunction(() => window.__mock?.marks.some(([n]) => n.startsWith("render-committed")));
  const highlighted = await page.evaluate(async () => {
    while (document.querySelectorAll(".code-block pre.plain").length) await new Promise((r) => requestAnimationFrame(r));
    return performance.now();
  });
  const t = await page.evaluate(() => ({
    ...window.__T,
    firstIpc: window.__firstIpc,
    read: window.__readAt,
    committed: window.__mock.marks.find(([n]) => n.startsWith("render-committed"))[1],
    workerStart: window.__T.worker.start - performance.timeOrigin,
  }));
  rows.push({ ...t, highlighted });
  await context.close();
}
await browser.close();
server.close();

const median = (key) => {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
const fmt = (n) => `${Math.round(n)} ms`;
console.log(`README cold start, median of ${RUNS} runs (ms since navigation start):`);
console.log(`  worker created           ${fmt(median("created"))}`);
console.log(`  first IPC (React mounted) ${fmt(median("firstIpc"))}`);
console.log(`  document read            ${fmt(median("read"))}`);
console.log(`  render requested         ${fmt(median("posted"))}`);
console.log(`  worker began rendering   ${fmt(median("workerStart"))}`);
console.log(`  render returned          ${fmt(median("received"))}`);
console.log(`  committed (visible)      ${fmt(median("committed"))}`);
console.log(`  all code highlighted     ${fmt(median("highlighted"))}`);
