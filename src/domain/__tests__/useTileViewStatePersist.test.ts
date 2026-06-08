import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTileViewStatePersist } from "../useTileViewStatePersist";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useTileViewStatePersist", () => {
  it("writes the merged config after the debounce window", () => {
    const onConfigChange = vi.fn();
    renderHook(
      ({ viewState }) =>
        useTileViewStatePersist(
          JSON.stringify({ cwd: "C:\\repo" }),
          "repo_explorer",
          viewState,
          onConfigChange,
          { debounceMs: 100 },
        ),
      { initialProps: { viewState: { activeTab: "files" } } },
    );
    expect(onConfigChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    const written = JSON.parse(onConfigChange.mock.calls[0][0]);
    expect(written).toEqual({
      cwd: "C:\\repo",
      viewState: { activeTab: "files" },
    });
  });

  it("coalesces bursts of changes into a single write with the last value", () => {
    const onConfigChange = vi.fn();
    const { rerender } = renderHook(
      ({ viewState }) =>
        useTileViewStatePersist(
          "{}",
          "repo_explorer",
          viewState,
          onConfigChange,
          { debounceMs: 100 },
        ),
      { initialProps: { viewState: { activeTab: "files" } as { activeTab: string } } },
    );
    rerender({ viewState: { activeTab: "diff" } });
    rerender({ viewState: { activeTab: "log" } });
    vi.advanceTimersByTime(50);
    expect(onConfigChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onConfigChange.mock.calls[0][0]).viewState).toEqual({ activeTab: "log" });
  });

  it("does not write when enabled is false (hydration cycle)", () => {
    const onConfigChange = vi.fn();
    renderHook(() =>
      useTileViewStatePersist(
        "{}",
        "repo_explorer",
        { activeTab: "files" },
        onConfigChange,
        { enabled: false, debounceMs: 50 },
      ),
    );
    vi.advanceTimersByTime(100);
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("does nothing when onConfigChange is undefined", () => {
    expect(() =>
      renderHook(() =>
        useTileViewStatePersist(
          "{}",
          "repo_explorer",
          { activeTab: "files" },
          undefined,
          { debounceMs: 50 },
        ),
      ),
    ).not.toThrow();
    vi.advanceTimersByTime(100);
  });
});
