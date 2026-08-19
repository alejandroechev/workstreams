import { describe, it, expect, vi, beforeEach } from "vitest";
import { TauriBackend } from "../tauri-backend";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("TauriBackend tasks", () => {
  let backend: TauriBackend;

  beforeEach(() => {
    invoke.mockReset();
    backend = new TauriBackend();
  });

  it("listTasks calls list_tasks", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.listTasks();
    expect(invoke).toHaveBeenCalledWith("list_tasks");
  });

  it("createTask sends camelCase keys so Tauri reaches the snake_case params", async () => {
    invoke.mockResolvedValueOnce({ id: "t1" });
    await backend.createTask("x", { workstreamId: "w1", labelNames: ["AI Crew"] });
    expect(invoke).toHaveBeenCalledWith("create_task", {
      title: "x",
      status: undefined,
      workstreamId: "w1",
      labelNames: ["AI Crew"],
    });
  });

  it("updateTask omits fields the caller did not set", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateTask("t1", { status: "done" });
    expect(invoke).toHaveBeenCalledWith("update_task", { id: "t1", status: "done" });
  });

  it("detaching a workstream sends an explicit clear flag, not a bare null", async () => {
    // `workstreamId: null` alone is indistinguishable from an absent field once
    // serde folds both into None, which would make detach a silent no-op.
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateTask("t1", { workstreamId: null });
    expect(invoke).toHaveBeenCalledWith("update_task", { id: "t1", clearWorkstream: true });
  });

  it("attaching a workstream sends the id and no clear flag", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateTask("t1", { workstreamId: "w2" });
    expect(invoke).toHaveBeenCalledWith("update_task", { id: "t1", workstreamId: "w2" });
  });

  it("setTaskLabels passes the raw names for backend-side dedupe", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.setTaskLabels("t1", ["ai crew"]);
    expect(invoke).toHaveBeenCalledWith("set_task_labels", {
      taskId: "t1",
      labelNames: ["ai crew"],
    });
  });

  it("addTaskEvent defaults to a manual source", async () => {
    invoke.mockResolvedValueOnce({ id: "e1" });
    await backend.addTaskEvent("t1", "note", "hi");
    expect(invoke).toHaveBeenCalledWith("add_task_event", {
      taskId: "t1",
      kind: "note",
      text: "hi",
      source: "manual",
    });
  });

  it("listTaskEvents omits taskId when listing everything", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.listTaskEvents();
    expect(invoke).toHaveBeenCalledWith("list_task_events", { taskId: undefined });
  });

  it("deleteTaskEvent exists but no update counterpart does", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.deleteTaskEvent("e1");
    expect(invoke).toHaveBeenCalledWith("delete_task_event", { id: "e1" });
    expect((backend as unknown as Record<string, unknown>).updateTaskEvent).toBeUndefined();
  });
});
