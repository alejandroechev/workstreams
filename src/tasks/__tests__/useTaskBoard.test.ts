import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

import { useTaskBoard } from "../useTaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";
import type { Backend } from "../../backend/types";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

async function mounted() {
  const hook = renderHook(() => useTaskBoard(backend));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("useTaskBoard", () => {
  it("loads tasks, labels and events together", async () => {
    const task = await backend.createTask("x", { status: "in_progress" });
    await backend.setTaskLabels(task.id, ["OfflineSDK"]);
    await backend.addTaskEvent(task.id, "note", "hi");

    const { result } = await mounted();
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.labels).toHaveLength(1);
    expect(result.current.events).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a load failure instead of hanging on loading forever", async () => {
    const failing = {
      listTasks: vi.fn().mockRejectedValue(new Error("db is gone")),
      listLabels: vi.fn().mockResolvedValue([]),
      listTaskEvents: vi.fn().mockResolvedValue([]),
    } as unknown as Backend;

    const { result } = renderHook(() => useTaskBoard(failing));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("db is gone");
  });

  it("records a status change as an auto event, not a typed one", async () => {
    // Board moves are the highest-volume signal available for free; if they
    // were recorded as manual they would pollute the exported page.
    const task = await backend.createTask("x");
    const { result } = await mounted();

    await act(async () => {
      await result.current.setStatus(task.id, "in_review");
    });

    const events = await backend.listTaskEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("status");
    expect(events[0].source).toBe("auto");
    expect(events[0].text).toContain("in review");
  });

  it("ignores a blank task title rather than creating an empty card", async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.createTask("   ");
    });
    expect(await backend.listTasks()).toHaveLength(0);
  });

  it("ignores a blank note", async () => {
    const task = await backend.createTask("x");
    const { result } = await mounted();
    await act(async () => {
      await result.current.addNote(task.id, "  ");
    });
    expect(await backend.listTaskEvents(task.id)).toHaveLength(0);
  });

  it("trims titles and notes so stray whitespace never reaches the archive", async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.createTask("  media_store read API  ");
    });
    expect((await backend.listTasks())[0].title).toBe("media_store read API");
  });

  it("reflects a deletion in the next render", async () => {
    const task = await backend.createTask("x");
    const { result } = await mounted();
    await act(async () => {
      await result.current.deleteTask(task.id);
    });
    expect(result.current.tasks).toHaveLength(0);
  });

  it("exposes no way to rewrite an event", async () => {
    const { result } = await mounted();
    expect((result.current as unknown as Record<string, unknown>).updateEvent).toBeUndefined();
    expect(typeof result.current.deleteEvent).toBe("function");
  });
});
