import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and serves the built assets from dist/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // PowerSync web SDK ships wa-sqlite (wasm + web workers). Exclude from the dep
  // optimizer so its workers/wasm are served correctly; workers as ES modules.
  optimizeDeps: {
    exclude: ["@journeyapps/wa-sqlite", "@powersync/web"],
    include: ["@powersync/web > js-logger"],
  },
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist" },
});
