import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../backend/memory-backend";
import { usePrInbox } from "../usePrInbox";

afterEach(() => vi.useRealTimers());

describe("global inbox snapshot subscription", () => {
  it("loads without an open inbox, observes later native/CLI changes and stops on unmount", async () => {
    vi.useFakeTimers();
    const backend = new MemoryBackend();
    const read = vi.spyOn(backend, "getPrInbox");
    const { result, unmount } = renderHook(() => usePrInbox(backend));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    backend.seedPrInboxItems([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(read).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("surfaces read errors, retries and refreshes after configuration", async () => {
    vi.useFakeTimers();
    const backend = new MemoryBackend();
    const project = await backend.createProject("Repo", "/repo");
    await backend.updateProject(project.id, { git_remote: "https://dev.azure.com/o/p/_git/r" });
    vi.spyOn(backend, "getPrInbox").mockRejectedValueOnce(new Error("Database unavailable"));
    const { result } = renderHook(() => usePrInbox(backend));
    await act(async () => {});
    expect(result.current.error).toBe("Database unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current.error).toBeNull();
    await act(async () => { await result.current.configure(project.id, "both"); });
    expect(result.current.snapshot.repos[0].enabled).toBe(true);
    expect(result.current.snapshot.repos[0].mode).toBe("both");
    await expect(result.current.setRead("missing", true)).rejects.toThrow("not found");
  });

  it("does not overlap reads or apply a response after unmount", async () => {
    vi.useFakeTimers();
    const backend = new MemoryBackend();
    let resolve!: (value: { items: []; repos: [] }) => void;
    const read = vi.spyOn(backend, "getPrInbox").mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { unmount } = renderHook(() => usePrInbox(backend));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(read).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { resolve({ items: [], repos: [] }); });
    expect(vi.getTimerCount()).toBe(0);
  });
});
