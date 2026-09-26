// Minimal static server for e2e runs: the production bundle (dist/), sent
// with the production CSP. (Fixture images are served by the harness as
// http://asset.localhost/…, like Tauri's asset protocol.)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(here, "..", "dist");
const CONF = JSON.parse(await readFile(join(here, "..", "src-tauri", "tauri.conf.json"), "utf8"));
/** The production CSP from tauri.conf.json, so violations fail the run. */
export const CSP = Object.entries(CONF.app.security.csp)
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join("; ");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
};

export function serve(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let path = decodeURIComponent(url.pathname);
      const base = DIST;
      if (path === "/favicon.ico") {
        // Browsers ask for one; WebKit in Tauri does not.
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === "/" || path.endsWith("/")) path += "index.html";
      const file = normalize(join(base, path));
      if (!file.startsWith(base)) throw new Error("outside root");
      await stat(file);
      const headers = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
      if (extname(file) === ".html") headers["content-security-policy"] = CSP;
      res.writeHead(200, headers);
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
