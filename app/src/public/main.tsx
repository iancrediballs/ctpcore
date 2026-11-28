// Public build entry (chinatruckparts.co.za): the REAL MobileShell, the app's
// catalogue screens, over the public fixture. See vite.public.config.ts.
import { createRoot } from "react-dom/client";
import "../styles.css";
import MobileShell from "../mobile/MobileShell";
createRoot(document.getElementById("root")!).render(<MobileShell />);
