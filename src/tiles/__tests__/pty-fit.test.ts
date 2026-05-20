import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPtyFitController } from "../pty-fit";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";

function makeFit(dims: { cols: number; rows: number } | null) {
  return {
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => (dims ? { ...dims } : undefined)),
    // FitAddon also has activate/dispose but the controller doesn't use them.
  } as unknown as import("@xterm/addon-fit").FitAddon;
}

function makeEl(width: number): HTMLElement {
  return { offsetWidth: width } as unknown as HTMLElement;
}

describe("createPtyFitController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (invoke as unknown as ReturnType<typeof vi.fn>).mockClear();
    // jsdom doesn't ship rAF in some setups; provide a sync stub.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0 as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("debounces multiple request() calls into one invoke", () => {
    const fit = makeFit({ cols: 80, rows: 24 });
    const ctl = createPtyFitController({
      tileId: "t1",
      fitAddon: fit,
      getContainer: () => makeEl(800),
      debounceMs: 50,
    });
    ctl.request();
    ctl.request();
    ctl.request();
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("resize_pty", { tileId: "t1", rows: 24, cols: 80 });
  });

  it("skips invoke when dimensions are unchanged from previous flush", () => {
    const fit = makeFit({ cols: 80, rows: 24 });
    const ctl = createPtyFitController({
      tileId: "t1",
      fitAddon: fit,
      getContainer: () => makeEl(800),
      debounceMs: 10,
    });
    ctl.request();
    vi.advanceTimersByTime(20);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Same dims → no extra invoke.
    ctl.request();
    vi.advanceTimersByTime(20);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does call invoke again when dims actually change", () => {
    const dims = { cols: 80, rows: 24 };
    const fit = makeFit(dims);
    const ctl = createPtyFitController({
      tileId: "t1",
      fitAddon: fit,
      getContainer: () => makeEl(800),
      debounceMs: 10,
    });
    ctl.request();
    vi.advanceTimersByTime(20);
    dims.cols = 90;
    ctl.request();
    vi.advanceTimersByTime(20);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("resize_pty", { tileId: "t1", rows: 24, cols: 90 });
  });

  it("skips fit when container has zero width", () => {
    const fit = makeFit({ cols: 80, rows: 24 });
    const ctl = createPtyFitController({
      tileId: "t1",
      fitAddon: fit,
      getContainer: () => makeEl(0),
      debounceMs: 10,
    });
    ctl.request();
    vi.advanceTimersByTime(20);
    expect(invoke).not.toHaveBeenCalled();
    expect(fit.fit).not.toHaveBeenCalled();
  });

  it("invalidate() forces a re-send even when dims didn't change", () => {
    const fit = makeFit({ cols: 80, rows: 24 });
    const ctl = createPtyFitController({
      tileId: "t1",
      fitAddon: fit,
      getContainer: () => makeEl(800),
      debounceMs: 10,
    });
    ctl.request();
    vi.advanceTimersByTime(20);
    expect(invoke).toHaveBeenCalledTimes(1);

    ctl.invalidate();
    ctl.request();
    vi.advanceTimersByTime(20);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("dispose() prevents further work", () => {
    const fit = makeFit({ cols: 80, rows: 24 });
    const ctl = createPtyFitController({
      tileId: "t1",
      fitAddon: fit,
      getContainer: () => makeEl(800),
      debounceMs: 10,
    });
    ctl.request();
    ctl.dispose();
    vi.advanceTimersByTime(20);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores nonsense dims (0/NaN)", () => {
    const fit = makeFit({ cols: 0, rows: 0 });
    const ctl = createPtyFitController({
      tileId: "t1",
      fitAddon: fit,
      getContainer: () => makeEl(800),
      debounceMs: 10,
    });
    ctl.request();
    vi.advanceTimersByTime(20);
    expect(invoke).not.toHaveBeenCalled();
  });
});
