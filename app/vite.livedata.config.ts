// Dev only: the REAL MobileShell and the REAL backend.web.ts SQL over a sql.js
// copy of live catalogue data (src/dev/live/fixture.<role>.json, not committed).
// `npx vite --config vite.livedata.config.ts` then /shell-harness.html?role=customer|admin.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const swap: Plugin = {
  name: "live-data-mocks",
  enforce: "pre",
  resolveId(src) {
    if (src.endsWith("/sync/system")) return at("./src/dev/live/system.mock.ts");
    if (src.endsWith("/sync/supabase")) return at("./src/dev/live/supabase.mock.ts");
    if (src.endsWith("auth/AuthProvider")) return at("./src/dev/shell/auth.mock.tsx");
    if (src === "@powersync/react") return at("./src/dev/live/powersync-react.mock.ts");
    return null;
  },
};
export default defineConfig({ plugins: [swap, react()], server: { port: 4175, strictPort: true },
  define: { __APP_VERSION__: JSON.stringify("livedata"), __APP_BUILT__: JSON.stringify("dev") } });
