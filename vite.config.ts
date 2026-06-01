import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const e2e = process.env.VITE_E2E === "1";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5177,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  resolve: e2e
    ? {
        alias: {
          "@tauri-apps/api/core": path.resolve(__dirname, "src/test-shims/tauri-core-shim.ts"),
          "@tauri-apps/api/event": path.resolve(__dirname, "src/test-shims/tauri-event-shim.ts"),
          "@tauri-apps/api/window": path.resolve(__dirname, "src/test-shims/tauri-window-shim.ts"),
          "@tauri-apps/plugin-dialog": path.resolve(__dirname, "src/test-shims/tauri-dialog-shim.ts"),
          "@tauri-apps/plugin-opener": path.resolve(__dirname, "src/test-shims/tauri-opener-shim.ts"),
          "@tauri-apps/plugin-clipboard-manager": path.resolve(__dirname, "src/test-shims/tauri-clipboard-shim.ts"),
        },
      }
    : undefined,
  define: e2e ? { "import.meta.env.VITE_E2E": JSON.stringify("1") } : undefined,
});
