import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Saved regex translations (src/render/regexCache.ts) are keyed by the
// translator's version.
const regexEngineVersion = JSON.parse(
  readFileSync(new URL("./node_modules/oniguruma-to-es/package.json", import.meta.url), "utf8"),
).version as string;

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __REGEX_ENGINE_VERSION__: JSON.stringify(regexEngineVersion),
  },
  // Keep Rust errors visible during `tauri dev`.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // macOS 13's WebKit.
    target: ["safari16"],
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    reportCompressedSize: false,
  },
  worker: {
    format: "es",
  },
});
