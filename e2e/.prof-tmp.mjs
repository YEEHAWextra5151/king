import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { serve } from "./serve.mjs";
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const mock = await readFile("e2e/mock-tauri.js", "utf8");
const readme = await readFile("e2e/fixtures/project/README.md", "utf8");
const commits = [], hls = [];
for (let run = 0; run < 5; run++) {
  const ctx = await browser.newContext();
  await ctx.route((u) => u.hostname !== "127.0.0.1", (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));
  const page = await ctx.newPage();
  await page.addInitScript({ content: `
    window.__T = {};
    const W = window.Worker;
    window.Worker = class extends W {
      constructor(...a) {
        super(...a);
        __T.created = performance.now();
        const post = this.postMessage.bind(this);
        this.postMessage = (m) => { if (m.type === "render" && !__T.posted) __T.posted = performance.now(); post(m); };
        this.addEventListener("message", (e) => { if (e.data.type === "rendered" && !__T.received) { __T.received = performance.now(); __T.timings = e.data.output.timings; } });
      }
    };
  ` });
  await page.addInitScript({ content: `window.__MOCK_FILES__ = ${JSON.stringify({ "/p/README.md": readme })}; window.__MOCK_SCENARIO__ = {root: "/p", pending: ["/p/README.md"]};\n${mock}` });
  await page.goto(base);
  await page.waitForSelector(".markdown-body h1");
  const hl = await page.evaluate(async () => {
    while (document.querySelectorAll(".code-block pre.plain").length) await new Promise((r) => requestAnimationFrame(r));
    return performance.now();
  });
  const data = await page.evaluate(() => ({
    worker: performance.getEntriesByType("resource").find((e) => e.name.includes("worker"))?.startTime,
    marks: window.__mock.marks.map(([n, t]) => [n, Math.round(t)]),
    T: window.__T,
    ipc: window.__mock.calls.slice(0, 8).map(([c, a, t]) => c),
  }));
  commits.push(data.marks[0][1]); hls.push(Math.round(hl));
  const T = data.T;
  console.log("   ipc order", data.ipc.join(","), "first-ipc", (await page.evaluate(() => window.__firstIpc|0)), "read_document", (await page.evaluate(() => window.__readAt|0)));
  console.log(`   created ${T.created|0} posted ${T.posted|0} received ${T.received|0} (worker parse ${T.timings.parse.toFixed(1)} render ${T.timings.render.toFixed(1)} total ${T.timings.total.toFixed(1)})`);
  console.log(`run ${run}: worker requested ${Math.round(data.worker)}ms, ${data.marks.map((m) => m.join(" @ ")).join("; ")}, all highlighted ${Math.round(hl)}ms`);
  await ctx.close();
}
commits.sort((a,b)=>a-b); hls.sort((a,b)=>a-b);
console.log(`median commit ${commits[2]}ms, median highlighted ${hls[2]}ms`);
await browser.close(); server.close();
