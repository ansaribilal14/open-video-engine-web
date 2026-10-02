import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production UI is built into `server/web-dist` and embedded into the
// `ove-web` binary (single-binary deployment). Dev mode proxies /api to a
// locally running server (cargo run in ../server).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../server/web-dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
