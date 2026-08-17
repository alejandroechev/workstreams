import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";

import { useAllFileComments } from "../useAllFileComments";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import type { Backend } from "../../backend/types";

function wrapperFor(backend: Backend) {
  return ({ children }: { children: ReactNode }) => (
    <BackendProvider backend={backend}>{children}</BackendProvider>
  );
}

async function seededBackend() {
  const backend = new MemoryBackend();
  backend.seedBoundSession("ws-1", "sess-1");
  await backend.addSessionFileComment("ws-1", "src/b.ts", 3, 3, null, "b3");
  await backend.addSessionFileComment("ws-1", "src/a.ts", 5, 5, null, "a5");
  return backend;
}

describe("useAllFileComments", () => {
  it("loads every comment in the workstream, ordered by file then line", async () => {
    const backend = await seededBackend();
    const { result } = renderHook(() => useAllFileComments("ws-1"), {
      wrapper: wrapperFor(backend),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments.map((c) => c.body)).toEqual(["a5", "b3"]);
    expect(result.current.error).toBeNull();
  });

  it("stays inert with no backend call when the workstream is null", async () => {
    const backend = await seededBackend();
    const spy = vi.spyOn(backend, "listAllSessionFileComments");

    const { result } = renderHook(() => useAllFileComments(null), {
      wrapper: wrapperFor(backend),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.comments).toEqual([]);
  });

  it("flags an unbound session distinctly instead of as a generic error", async () => {
    const backend = new MemoryBackend(); // no seedBoundSession
    const { result } = renderHook(() => useAllFileComments("ws-1"), {
      wrapper: wrapperFor(backend),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unbound).toBe(true);
    expect(result.current.comments).toEqual([]);
  });

  it("picks up comments added out-of-band on reload", async () => {
    const backend = await seededBackend();
    const { result } = renderHook(() => useAllFileComments("ws-1"), {
      wrapper: wrapperFor(backend),
    });
    await waitFor(() => expect(result.current.comments).toHaveLength(2));

    await backend.addSessionFileComment("ws-1", "src/c.ts", 1, 1, null, "c1");
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.comments.map((c) => c.body)).toEqual(["a5", "b3", "c1"]);
  });

  it("ignores a stale in-flight response that resolves after a newer one", async () => {
    const backend = await seededBackend();
    let releaseFirst: (v: []) => void = () => {};
    const spy = vi
      .spyOn(backend, "listAllSessionFileComments")
      .mockImplementationOnce(
        () => new Promise((resolve) => { releaseFirst = resolve as (v: []) => void; }),
      );

    const { result } = renderHook(() => useAllFileComments("ws-1"), {
      wrapper: wrapperFor(backend),
    });

    spy.mockRestore();
    await act(async () => {
      await result.current.reload();
    });
    await waitFor(() => expect(result.current.comments).toHaveLength(2));

    // The first (stale) request finally resolves with an empty list.
    await act(async () => {
      releaseFirst([]);
    });

    expect(result.current.comments).toHaveLength(2);
  });
});
