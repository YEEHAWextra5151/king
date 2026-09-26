import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
