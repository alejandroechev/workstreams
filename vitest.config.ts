import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    exclude: ["node_modules", "dist", "e2e/**", ".dev/**"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/backend/**"],
      exclude: [
        "src/domain/types.ts",
        "src/backend/types.ts",
        "**/*.test.ts",
        "**/*.test.tsx",
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
