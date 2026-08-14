import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduleTerminalRevealRecovery } from "../terminal-reveal";

describe("scheduleTerminalRevealRecovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("remeasures, fits, reloads the renderer, and repaints on two settled passes", () => {
    vi.useFakeTimers();
    const raf = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const measure = vi.fn();
    const handleResize = vi.fn();
    const refresh = vi.fn();
    const invalidate = vi.fn();
    const request = vi.fn();
    const tryLoad = vi.fn();

    const dispose = scheduleTerminalRevealRecovery({
      terminal: {
        cols: 120,
        rows: 40,
        refresh,
        _core: {
          _charSizeService: { measure },
          _renderService: { handleResize },
        },
      },
      ptyFit: { invalidate, request },
      webgl: { tryLoad },
      getContainer: () => ({ offsetWidth: 960, offsetHeight: 640 }),
      settleMs: 150,
    });

    expect(tryLoad).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(handleResize).toHaveBeenCalledWith(120, 40);
    expect(refresh).toHaveBeenCalledWith(0, 39);

    vi.advanceTimersByTime(150);
    expect(tryLoad).toHaveBeenCalledTimes(2);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("does no terminal work while the container has no layout size", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const refresh = vi.fn();
    const request = vi.fn();

    scheduleTerminalRevealRecovery({
      terminal: { cols: 80, rows: 24, refresh },
      ptyFit: { invalidate: vi.fn(), request },
      webgl: { tryLoad: vi.fn() },
      getContainer: () => ({ offsetWidth: 0, offsetHeight: 0 }),
      maxUnsizedRetries: 0,
    });

    expect(request).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("recovers when layout becomes sized after the first reveal pass", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let sized = false;
    const refresh = vi.fn();
    const request = vi.fn();
    scheduleTerminalRevealRecovery({
      terminal: { cols: 80, rows: 24, refresh },
      ptyFit: { invalidate: vi.fn(), request },
      webgl: { tryLoad: vi.fn() },
      getContainer: () =>
        sized
          ? { offsetWidth: 800, offsetHeight: 600 }
          : { offsetWidth: 0, offsetHeight: 0 },
      retryMs: 150,
    });

    expect(refresh).not.toHaveBeenCalled();
    sized = true;
    vi.advanceTimersByTime(150);
    expect(request).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(0, 23);
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cancels the delayed repaint when the workstream hides again", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const refresh = vi.fn();
    const dispose = scheduleTerminalRevealRecovery({
      terminal: { cols: 80, rows: 24, refresh },
      ptyFit: { invalidate: vi.fn(), request: vi.fn() },
      webgl: { tryLoad: vi.fn() },
      getContainer: () => ({ offsetWidth: 800, offsetHeight: 600 }),
      settleMs: 150,
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    dispose();
    vi.advanceTimersByTime(150);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
