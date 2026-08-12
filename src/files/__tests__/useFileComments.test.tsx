import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import { useFileComments } from "../useFileComments";

const ROOT = "C:/repo";

function wrap(backend: MemoryBackend) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <BackendProvider backend={backend}>{children}</BackendProvider>;
  };
}

describe("useFileComments", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
    backend.seedBoundSession("ws-1", "sess-1");
  });

  it("starts empty and inert when workstreamId/path are null", () => {
    const { result } = renderHook(() => useFileComments(null, null, null), {
      wrapper: wrap(backend),
    });
    expect(result.current.comments).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("loads existing comments on mount, keyed on the repo-relative path", async () => {
    await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "hello");
    const { result } = renderHook(() => useFileComments("ws-1", ROOT, "C:/repo/src/a.ts"), {
      wrapper: wrap(backend),
    });
    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(result.current.comments[0].body).toBe("hello");
    expect(result.current.file).toBe("src/a.ts");
  });

  it("surfaces an error when the workstream has no linked session", async () => {
    const { result } = renderHook(() => useFileComments("ws-unbound", ROOT, "C:/repo/src/a.ts"), {
      wrapper: wrap(backend),
    });
    await waitFor(() => expect(result.current.error).toMatch(/linked Copilot session/i));
  });

  it("add inserts and keeps the list sorted by anchor_line_start", async () => {
    const { result } = renderHook(() => useFileComments("ws-1", ROOT, "C:/repo/src/a.ts"), {
      wrapper: wrap(backend),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.add(10, 10, null, "second");
      await result.current.add(2, 4, null, "first");
    });
    expect(result.current.comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("update replaces the comment in local state", async () => {
    const { result } = renderHook(() => useFileComments("ws-1", ROOT, "C:/repo/src/a.ts"), {
      wrapper: wrap(backend),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let id = "";
    await act(async () => {
      const c = await result.current.add(1, 1, null, "old");
      id = c.id;
    });
    await act(async () => {
      await result.current.update(id, "new");
    });
    expect(result.current.comments[0].body).toBe("new");
  });

  it("setStatus updates the comment status in local state", async () => {
    const { result } = renderHook(() => useFileComments("ws-1", ROOT, "C:/repo/src/a.ts"), {
      wrapper: wrap(backend),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let id = "";
    await act(async () => {
      const c = await result.current.add(1, 1, null, "x");
      id = c.id;
    });
    await act(async () => {
      await result.current.setStatus(id, "resolved");
    });
    expect(result.current.comments[0].status).toBe("resolved");
  });

  it("remove deletes the note and cascades its replies from local state", async () => {
    const { result } = renderHook(() => useFileComments("ws-1", ROOT, "C:/repo/src/a.ts"), {
      wrapper: wrap(backend),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let id = "";
    await act(async () => {
      const c = await result.current.add(1, 1, null, "x");
      id = c.id;
      await backend.replySessionFileComment("ws-1", id, "reply");
    });
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.comments).toHaveLength(2);
    await act(async () => {
      await result.current.remove(id);
    });
    expect(result.current.comments).toEqual([]);
  });

  it("reply adds a threaded reply and keeps local state in sync", async () => {
    const { result } = renderHook(() => useFileComments("ws-1", ROOT, "C:/repo/src/a.ts"), {
      wrapper: wrap(backend),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let rootId = "";
    await act(async () => {
      const c = await result.current.add(3, 3, null, "please fix");
      rootId = c.id;
    });
    await act(async () => {
      const r = await result.current.reply(rootId, "done");
      expect(r.parent_id).toBe(rootId);
      expect(r.author).toBe("reviewer");
    });
    expect(result.current.comments).toHaveLength(2);
    const reply = result.current.comments.find((c) => c.parent_id === rootId);
    expect(reply?.body).toBe("done");
  });

  it("re-loads when path changes", async () => {
    await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "a-comment");
    await backend.addSessionFileComment("ws-1", "src/b.ts", 1, 1, null, "b-comment");
    const { result, rerender } = renderHook(
      ({ p }: { p: string }) => useFileComments("ws-1", ROOT, p),
      { wrapper: wrap(backend), initialProps: { p: "C:/repo/src/a.ts" } },
    );
    await waitFor(() => expect(result.current.comments[0]?.body).toBe("a-comment"));
    rerender({ p: "C:/repo/src/b.ts" });
    expect(result.current.comments).toEqual([]);
    await waitFor(() => expect(result.current.comments[0]?.body).toBe("b-comment"));
  });

  it("ignores a stale reload that finishes after the selected file changes", async () => {
    await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "a-comment");
    await backend.addSessionFileComment("ws-1", "src/b.ts", 1, 1, null, "b-comment");
    const list = backend.listSessionFileComments.bind(backend);
    const aComments = await list("ws-1", "src/a.ts");
    let finishA: ((comments: typeof aComments) => void) | null = null;
    backend.listSessionFileComments = async (workstreamId, file) => {
      if (file === "src/a.ts") {
        return new Promise((resolve) => {
          finishA = resolve;
        });
      }
      return list(workstreamId, file);
    };

    const { result, rerender } = renderHook(
      ({ p }: { p: string }) => useFileComments("ws-1", ROOT, p),
      { wrapper: wrap(backend), initialProps: { p: "C:/repo/src/a.ts" } },
    );
    await waitFor(() => expect(finishA).not.toBeNull());
    rerender({ p: "C:/repo/src/b.ts" });
    await waitFor(() => expect(result.current.comments[0]?.body).toBe("b-comment"));

    await act(async () => {
      finishA?.(aComments);
      await Promise.resolve();
    });
    expect(result.current.comments[0]?.body).toBe("b-comment");
  });

  it("does not let a stale list response erase a newly added comment", async () => {
    let finishList: ((comments: []) => void) | null = null;
    backend.listSessionFileComments = async () =>
      new Promise((resolve) => {
        finishList = resolve;
      });
    const { result } = renderHook(
      () => useFileComments("ws-1", ROOT, "C:/repo/src/a.ts"),
      { wrapper: wrap(backend) },
    );
    await waitFor(() => expect(finishList).not.toBeNull());

    await act(async () => {
      await result.current.add(2, 2, "line two", "new comment");
    });
    expect(result.current.comments[0]?.body).toBe("new comment");

    await act(async () => {
      finishList?.([]);
      await Promise.resolve();
    });
    expect(result.current.comments[0]?.body).toBe("new comment");
  });

  it("does not let a slow add from the previous file replace current comments", async () => {
    await backend.addSessionFileComment("ws-1", "src/b.ts", 1, 1, null, "b-comment");
    const realAdd = backend.addSessionFileComment.bind(backend);
    let finishAdd: (() => void) | null = null;
    backend.addSessionFileComment = async (...args) =>
      new Promise((resolve) => {
        finishAdd = () => {
          void realAdd(...args).then(resolve);
        };
      });
    const { result, rerender } = renderHook(
      ({ p }: { p: string }) => useFileComments("ws-1", ROOT, p),
      { wrapper: wrap(backend), initialProps: { p: "C:/repo/src/a.ts" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    let pendingAdd!: Promise<unknown>;
    act(() => {
      pendingAdd = result.current.add(1, 1, "a", "a-comment");
    });
    rerender({ p: "C:/repo/src/b.ts" });
    await waitFor(() => expect(result.current.comments[0]?.body).toBe("b-comment"));

    await act(async () => {
      finishAdd?.();
      await pendingAdd;
    });
    expect(result.current.comments[0]?.body).toBe("b-comment");
  });

  it("does not let a stale list response erase a newly added reply", async () => {
    const root = await backend.addSessionFileComment(
      "ws-1",
      "src/a.ts",
      1,
      1,
      null,
      "root",
    );
    const realList = backend.listSessionFileComments.bind(backend);
    let finishList: (() => void) | null = null;
    backend.listSessionFileComments = async (...args) =>
      new Promise((resolve) => {
        finishList = () => {
          void realList(...args).then((comments) =>
            resolve(comments.filter((comment) => comment.parent_id === null)),
          );
        };
      });
    const { result } = renderHook(
      () => useFileComments("ws-1", ROOT, "C:/repo/src/a.ts"),
      { wrapper: wrap(backend) },
    );
    await waitFor(() => expect(finishList).not.toBeNull());
    await act(async () => {
      await result.current.reply(root.id, "reply");
    });
    expect(result.current.comments.some((comment) => comment.body === "reply")).toBe(true);

    await act(async () => {
      finishList?.();
      await Promise.resolve();
    });
    expect(result.current.comments.some((comment) => comment.body === "reply")).toBe(true);
  });

  it("add throws when no workstreamId/path is set", async () => {
    const { result } = renderHook(() => useFileComments(null, null, null), {
      wrapper: wrap(backend),
    });
    await expect(result.current.add(1, 1, null, "x")).rejects.toThrow();
  });
});
