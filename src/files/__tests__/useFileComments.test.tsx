import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import { useFileComments } from "../useFileComments";

function wrap(backend: MemoryBackend) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <BackendProvider backend={backend}>{children}</BackendProvider>;
  };
}

describe("useFileComments", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  it("starts empty and inert when workstreamId/path are null", () => {
    const { result } = renderHook(() => useFileComments(null, null), { wrapper: wrap(backend) });
    expect(result.current.comments).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("loads existing comments on mount", async () => {
    await backend.addFileComment("ws-1", "C:/a.ts", 1, 1, null, "hello");
    const { result } = renderHook(() => useFileComments("ws-1", "C:/a.ts"), { wrapper: wrap(backend) });
    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(result.current.comments[0].body_md).toBe("hello");
  });

  it("add inserts and keeps the list sorted by anchor_line_start", async () => {
    const { result } = renderHook(() => useFileComments("ws-1", "C:/a.ts"), { wrapper: wrap(backend) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.add(10, 10, null, "second");
      await result.current.add(2, 4, null, "first");
    });
    expect(result.current.comments.map((c) => c.body_md)).toEqual(["first", "second"]);
  });

  it("update replaces the comment in local state", async () => {
    const { result } = renderHook(() => useFileComments("ws-1", "C:/a.ts"), { wrapper: wrap(backend) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let id = "";
    await act(async () => {
      const c = await result.current.add(1, 1, null, "old");
      id = c.id;
    });
    await act(async () => {
      await result.current.update(id, "new");
    });
    expect(result.current.comments[0].body_md).toBe("new");
  });

  it("remove deletes from local state", async () => {
    const { result } = renderHook(() => useFileComments("ws-1", "C:/a.ts"), { wrapper: wrap(backend) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let id = "";
    await act(async () => {
      const c = await result.current.add(1, 1, null, "x");
      id = c.id;
    });
    await act(async () => {
      await result.current.remove(id);
    });
    expect(result.current.comments).toEqual([]);
  });

  it("re-loads when path changes", async () => {
    await backend.addFileComment("ws-1", "C:/a.ts", 1, 1, null, "a-comment");
    await backend.addFileComment("ws-1", "C:/b.ts", 1, 1, null, "b-comment");
    const { result, rerender } = renderHook(
      ({ p }: { p: string }) => useFileComments("ws-1", p),
      { wrapper: wrap(backend), initialProps: { p: "C:/a.ts" } },
    );
    await waitFor(() => expect(result.current.comments[0]?.body_md).toBe("a-comment"));
    rerender({ p: "C:/b.ts" });
    await waitFor(() => expect(result.current.comments[0]?.body_md).toBe("b-comment"));
  });

  it("add throws when no workstreamId/path is set", async () => {
    const { result } = renderHook(() => useFileComments(null, null), { wrapper: wrap(backend) });
    await expect(result.current.add(1, 1, null, "x")).rejects.toThrow();
  });
});
