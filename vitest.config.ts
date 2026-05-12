import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/backend/**"],
      exclude: [
        "src/domain/types.ts",
        "src/backend/types.ts",
        "src/backend/tauri-backend.ts",
        "src/backend/context.tsx",
        "src/domain/notifications.ts",
        "**/*.test.ts",
        "**/__tests__/**",
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
