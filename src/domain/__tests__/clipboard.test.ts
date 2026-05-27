import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pluginWriteText: vi.fn(async (_text: string) => {}),
  pluginReadText: vi.fn(async () => ""),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.pluginWriteText,
  readText: mocks.pluginReadText,
}));

import { writeTextToClipboard, readTextFromClipboard } from "../clipboard";

afterEach(() => {
  mocks.pluginWriteText.mockReset();
  mocks.pluginReadText.mockReset();
  vi.restoreAllMocks();
});

describe("clipboard helper", () => {
  it("writes via the Tauri plugin", async () => {
    mocks.pluginWriteText.mockResolvedValueOnce(undefined);
    await writeTextToClipboard("hello");
    expect(mocks.pluginWriteText).toHaveBeenCalledWith("hello");
  });

  it("falls back to navigator.clipboard when plugin throws", async () => {
    mocks.pluginWriteText.mockRejectedValueOnce(new Error("no host"));
    const navWrite = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: navWrite, readText: vi.fn() },
    });

    await writeTextToClipboard("hello");

    expect(navWrite).toHaveBeenCalledWith("hello");
  });

  it("reads via the Tauri plugin", async () => {
    mocks.pluginReadText.mockResolvedValueOnce("from-plugin");
    await expect(readTextFromClipboard()).resolves.toBe("from-plugin");
  });

  it("falls back to navigator.clipboard read when plugin throws", async () => {
    mocks.pluginReadText.mockRejectedValueOnce(new Error("no host"));
    const navRead = vi.fn(async () => "from-nav");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(), readText: navRead },
    });

    await expect(readTextFromClipboard()).resolves.toBe("from-nav");
  });
});
