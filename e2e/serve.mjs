// Minimal static server for e2e runs: the production bundle (dist/) plus
// fixture files under /__fixtures__/.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(here, "..", "dist");
const FIXTURES = join(here, "fixtures", "project");
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
      let base = DIST;
      if (path.startsWith("/__fixtures__/")) {
        base = FIXTURES;
        path = path.slice("/__fixtures__".length);
      }
      if (path === "/" || path.endsWith("/")) path += "index.html";
      const file = normalize(join(base, path));
      if (!file.startsWith(base)) throw new Error("outside root");
      await stat(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
