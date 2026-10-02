import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type WindowConfig = { title?: string; backgroundThrottling?: string };

function windows(file: string): WindowConfig[] {
  const config = JSON.parse(readFileSync(resolve(__dirname, "../../src-tauri", file), "utf8"));
  return config.app?.windows ?? [];
}

/**
 * The phone companion (ADR 033) relies on the main window's page staying live
 * while minimised. With macOS's default policy the page of a minimised window
 * was suspended after ~10–14 minutes: no requests were executed and presence
 * stopped, and queued requests then ran ~39 minutes late on restore
 * (workstreams-companion spike, 2026-10-02).
 */
describe("main window background throttling", () => {
  it.each(["tauri.conf.json", "tauri.conf.dev.json"])("is disabled in %s", (file) => {
    const configured = windows(file);
    expect(configured.length).toBeGreaterThan(0);
    for (const window of configured) {
      expect(window.backgroundThrottling, window.title).toBe("disabled");
    }
  });
});
