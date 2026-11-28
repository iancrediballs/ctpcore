// The PUBLIC website's copy of the app (chinatruckparts.co.za, Ian 28 Nov 2026:
// "copy the app identically ... everything except prices").
//
// Builds the REAL MobileShell with its data, auth and sync modules swapped for
// src/public/*: an in-browser SQLite seeded from the `public-fixture` edge
// function (the customer sync bucket, no prices or cost). __PUBLIC__ hides the
// parts of the shell a visitor has no use for (request list, account, prices).
//
//   npx vite build --config vite.public.config.ts   -> dist-public/
//   npx vite --config vite.public.config.ts          -> /public-site.html
//
// The output is copied into the ctp-website repo (static/app/) by
// ../server/publish_public_app.sh.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const swap: Plugin = {
  name: "public-site-swaps",
  enforce: "pre",
  resolveId(src) {
    if (src.endsWith("/sync/system")) return at("./src/public/system.ts");
    if (src.endsWith("/sync/supabase")) return at("./src/public/supabase.ts");
    if (src.endsWith("auth/AuthProvider")) return at("./src/public/auth.tsx");
    if (src === "@powersync/react") return at("./src/public/powersync-react.ts");
    if (src === "@powersync/web") return at("./src/public/powersync-web.stub.ts");
    return null;
  },
};
export default defineConfig({
  plugins: [swap, react()],
  base: "/app/",
  // app/public holds the PWA service worker and manifest: never ship those to
  // the website. The two logo files are copied by publish_public_app.sh.
  publicDir: false,
  define: {
    __APP_VERSION__: JSON.stringify("public"),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")),
    __PUBLIC__: "true",
  },
  server: { port: 4176, strictPort: true },
  build: {
    outDir: "dist-public",
    emptyOutDir: true,
    rollupOptions: { input: at("./public-site.html") },
  },
});
