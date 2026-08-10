import { describe, it, expect, vi, beforeEach } from "vitest";

const loaderConfig = vi.hoisted(() => vi.fn());
const loadMonacoMock = vi.hoisted(() => vi.fn());

vi.mock("@monaco-editor/react", () => ({
  loader: { config: loaderConfig },
}));
vi.mock("../loadMonaco", () => ({
  loadMonaco: loadMonacoMock,
}));

import {
  ensureLocalMonacoLoader,
  _resetMonacoLoaderConfigForTests,
} from "../monacoLoaderConfig";

describe("ensureLocalMonacoLoader", () => {
  beforeEach(() => {
    loaderConfig.mockReset();
    loadMonacoMock.mockReset();
    _resetMonacoLoaderConfigForTests();
  });

  it("hands the locally-bundled Monaco to the react loader", async () => {
    // Without this the loader fetches Monaco from cdn.jsdelivr.net, so the
    // diff editors silently fail with no network — in a desktop app that
    // already ships the whole of Monaco.
    const monaco = { editor: {} };
    loadMonacoMock.mockResolvedValue(monaco);

    await ensureLocalMonacoLoader();

    expect(loaderConfig).toHaveBeenCalledWith({ monaco });
  });

  it("configures only once no matter how often it is called", async () => {
    loadMonacoMock.mockResolvedValue({ editor: {} });

    await Promise.all([
      ensureLocalMonacoLoader(),
      ensureLocalMonacoLoader(),
      ensureLocalMonacoLoader(),
    ]);

    expect(loadMonacoMock).toHaveBeenCalledTimes(1);
    expect(loaderConfig).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default loader when Monaco cannot be loaded", async () => {
    // Best-effort: leaving the CDN path in place is better than rejecting and
    // taking down whatever awaited this during bootstrap.
    loadMonacoMock.mockRejectedValue(new Error("chunk load failed"));

    await expect(ensureLocalMonacoLoader()).resolves.toBeUndefined();
    expect(loaderConfig).not.toHaveBeenCalled();
  });
});
