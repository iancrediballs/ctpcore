// Dev only: the REAL MobileShell over mocked data/auth/sync modules, so the
// UI can be exercised without a sign-in. `npx vite --config vite.harness.config.ts`
// then open /shell-harness.html. Not used by the build.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const mock = (p: string) => fileURLToPath(new URL("./src/dev/shell/" + p, import.meta.url));
const swap: Plugin = {
  name: "shell-harness-mocks",
  enforce: "pre",
  resolveId(src) {
    if (src.endsWith("/backend.web")) return mock("backend.mock.ts");
    if (src.endsWith("auth/AuthProvider")) return mock("auth.mock.tsx");
    if (src === "@powersync/react") return mock("powersync.mock.ts");
    return null;
  },
};
export default defineConfig({ plugins: [swap, react()], server: { port: 4174, strictPort: true } });
