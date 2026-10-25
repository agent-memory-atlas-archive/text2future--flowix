import { createRoot } from "react-dom/client";

import App from "@app/app";
import { installDesktopShutdown } from "@app/desktop-shutdown";
import "@/styles/index.css";
import "sonner/dist/styles.css";
import { initTauriClient } from "@platform/tauri/client";
import { getPlatform } from "@/lib/shortcuts/platform";

import { createLogger } from '@/lib/logger';
const logger = createLogger('desktop entry');
const isMac = navigator.platform.toUpperCase().includes("MAC");
document.documentElement.dataset.platform = isMac ? "mac" : "non-mac";
document.documentElement.dataset.os = getPlatform();

// The desktop bridge is initialized by the desktop entry.
try {
  initTauriClient();
} catch (error) {
  logger.error('Failed to initialize Tauri', { error });
}

installDesktopShutdown();

createRoot(document.getElementById("root")!).render(<App />);
