import { defineConfig } from "@playwright/test";
import path from "node:path";

const PORT = 5177;
const clipId = process.env.WORKSTREAMS_DEMO_CLIP ?? "unassigned";
const outputDir =
  process.env.WORKSTREAMS_DEMO_OUTPUT_DIR ??
  path.join(".dev", "demo-media", clipId);

export default defineConfig({
  testDir: "./e2e/demos",
  testMatch: /.*\.spec\.ts$/,
  outputDir,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    deviceScaleFactor: 1,
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 8_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "demo-chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "npm run dev:e2e",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
