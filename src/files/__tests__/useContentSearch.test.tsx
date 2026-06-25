import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import { useContentSearch } from "../useContentSearch";

function wrap(backend: MemoryBackend) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <BackendProvider backend={backend}>{children}</BackendProvider>;
  };
}

// Small debounce so tests stay fast with real timers.
const OPTS = { debounceMs: 5, minLength: 2, limit: 1000 } as const;

describe("useContentSearch", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  it("starts empty and inert", () => {
    const { result } = renderHook(() => useContentSearch("/repo", OPTS), { wrapper: wrap(backend) });
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.truncated).toBe(false);
    expect(result.current.query).toBe("");
  });

  it("does not search for a query shorter than minLength", async () => {
    backend.seedFile("/repo/a.ts", "needle here");
    const spy = vi.spyOn(backend, "searchInFiles");
    const { result } = renderHook(() => useContentSearch("/repo", OPTS), { wrapper: wrap(backend) });
    act(() => result.current.setQuery("n")); // 1 char < minLength 2
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it("searches once the query reaches minLength and returns grouped-flat matches", async () => {
    backend.seedFile("/repo/a.ts", "alpha needle\nbeta\nneedle again");
    const { result } = renderHook(() => useContentSearch("/repo", OPTS), { wrapper: wrap(backend) });
    act(() => result.current.setQuery("needle"));
    await waitFor(() => expect(result.current.results.length).toBe(2));
    expect(result.current.results[0]).toMatchObject({ path: "/repo/a.ts", line_number: 1 });
    expect(result.current.results[1]).toMatchObject({ path: "/repo/a.ts", line_number: 3 });
  });

  it("debounces rapid query changes (only the final query is searched)", async () => {
    backend.seedFile("/repo/a.ts", "foo\nbar");
    const spy = vi.spyOn(backend, "searchInFiles");
    const { result } = renderHook(() => useContentSearch("/repo", { ...OPTS, debounceMs: 30 }), {
      wrapper: wrap(backend),
    });
    act(() => result.current.setQuery("fo"));
    act(() => result.current.setQuery("foo"));
    await waitFor(() => expect(result.current.results.length).toBe(1));
    // Only the settled query triggered an actual search.
    const queriesSearched = spy.mock.calls.map((c) => c[1]);
    expect(queriesSearched).toEqual(["foo"]);
  });

  it("cancels any in-flight search before starting a new one", async () => {
    backend.seedFile("/repo/a.ts", "needle");
    const cancelSpy = vi.spyOn(backend, "cancelSearches");
    const { result } = renderHook(() => useContentSearch("/repo", OPTS), { wrapper: wrap(backend) });
    act(() => result.current.setQuery("needle"));
    await waitFor(() => expect(result.current.results.length).toBe(1));
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("toggles loading false after the search settles", async () => {
    backend.seedFile("/repo/a.ts", "needle");
    const { result } = renderHook(() => useContentSearch("/repo", OPTS), { wrapper: wrap(backend) });
    act(() => result.current.setQuery("needle"));
    await waitFor(() => expect(result.current.results.length).toBe(1));
    expect(result.current.loading).toBe(false);
  });

  it("clearing the query resets results to empty without searching", async () => {
    backend.seedFile("/repo/a.ts", "needle");
    const { result } = renderHook(() => useContentSearch("/repo", OPTS), { wrapper: wrap(backend) });
    act(() => result.current.setQuery("needle"));
    await waitFor(() => expect(result.current.results.length).toBe(1));
    act(() => result.current.setQuery(""));
    await waitFor(() => expect(result.current.results).toEqual([]));
  });

  it("sets truncated when results reach the cap", async () => {
    // limit 3; seed a file with 5 matching lines → backend returns up to 3.
    backend.seedFile("/repo/a.ts", "needle\nneedle\nneedle\nneedle\nneedle");
    const { result } = renderHook(() => useContentSearch("/repo", { ...OPTS, limit: 3 }), {
      wrapper: wrap(backend),
    });
    act(() => result.current.setQuery("needle"));
    await waitFor(() => expect(result.current.results.length).toBe(3));
    expect(result.current.truncated).toBe(true);
  });

  it("cancels in-flight search on unmount", async () => {
    backend.seedFile("/repo/a.ts", "needle");
    const cancelSpy = vi.spyOn(backend, "cancelSearches");
    const { result, unmount } = renderHook(() => useContentSearch("/repo", OPTS), {
      wrapper: wrap(backend),
    });
    act(() => result.current.setQuery("needle"));
    await waitFor(() => expect(result.current.results.length).toBe(1));
    cancelSpy.mockClear();
    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});
