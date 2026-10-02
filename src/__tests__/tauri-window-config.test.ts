import { describe, it, expect } from "vitest";
import prodConfig from "../../src-tauri/tauri.conf.json";
import devConfig from "../../src-tauri/tauri.conf.dev.json";

type WindowConfig = { title?: string; backgroundThrottling?: string };

/**
 * The phone companion (ADR 033) relies on the main window's page staying live
 * while minimised. With macOS's default policy the page of a minimised window
 * was suspended after ~10–14 minutes: no requests were executed and presence
 * stopped, and queued requests then ran ~39 minutes late on restore
 * (workstreams-companion spike, 2026-10-02).
 */
describe("main window background throttling", () => {
  it.each([
    ["tauri.conf.json", prodConfig],
    ["tauri.conf.dev.json", devConfig],
  ])("is disabled in %s", (_file, config) => {
    const windows = (config.app?.windows ?? []) as WindowConfig[];
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect(window.backgroundThrottling, window.title).toBe("disabled");
    }
  });
});
