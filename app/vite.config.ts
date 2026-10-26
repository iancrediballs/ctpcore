import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// The app version shown in the app = the service-worker cache version (public/sw.js), so the
// number on screen is exactly the build the phone is running (Ian, 24 Oct).
const SW_VERSION = (readFileSync(new URL("./public/sw.js", import.meta.url), "utf8").match(/ctp-core-(v\d+)/) ?? [])[1] ?? "dev";

// SO-6: the service worker precaches the app shell on INSTALL, so the very
// first visit is enough to reopen the app offline. It needs the hashed file
// names, which only the build knows: this writes them to dist/precache.json.
// The "mc-" wa-sqlite builds (SQLCipher, used only with an encryption key) are
// left out — 3.8 MB the app never loads.
const precacheManifest = (): Plugin => ({
  name: "ctp-precache-manifest",
  apply: "build",
  generateBundle(_opts, bundle) {
    const files = Object.keys(bundle)
      .filter((f) => f.startsWith("assets/") && !/(^|\/)mc-/.test(f))
      .sort()
      .map((f) => "/" + f);
    this.emitFile({ type: "asset", fileName: "precache.json", source: JSON.stringify({ files }, null, 1) });
  },
});

// Tauri expects a fixed port and serves the built assets from dist/
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(SW_VERSION), __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")) },
  plugins: [react(), precacheManifest()],
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
