import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../memory-backend";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

describe("tasks", () => {
  it("starts empty, because day one is deliberately not seeded or imported", () => {
    return expect(backend.listTasks()).resolves.toEqual([]);
  });

  it("creates a task with no workstream and no labels", async () => {
    const task = await backend.createTask("media_store read API");
    expect(task.title).toBe("media_store read API");
    expect(task.workstreamId).toBeNull();
    expect(task.status).toBe("todo");
    expect(await backend.listTasks()).toHaveLength(1);
  });

  it("updates status and stamps completedAt when the task becomes terminal", async () => {
    const task = await backend.createTask("x");
    await backend.updateTask(task.id, { status: "done" });

    const [stored] = await backend.listTasks();
    expect(stored.status).toBe("done");
    expect(stored.completedAt).not.toBeNull();
  });

  it("stamps completedAt for cancelled too, so it leaves the board the same way", async () => {
    const task = await backend.createTask("x");
    await backend.updateTask(task.id, { status: "cancelled" });
    const [stored] = await backend.listTasks();
    expect(stored.completedAt).not.toBeNull();
  });

  it("clears completedAt when a finished task is reopened", async () => {
    const task = await backend.createTask("x");
    await backend.updateTask(task.id, { status: "done" });
    await backend.updateTask(task.id, { status: "in_progress" });

    const [stored] = await backend.listTasks();
    expect(stored.completedAt).toBeNull();
  });

  it("attaches and detaches a workstream", async () => {
    const task = await backend.createTask("x");
    await backend.updateTask(task.id, { workstreamId: "w1" });
    expect((await backend.listTasks())[0].workstreamId).toBe("w1");

    await backend.updateTask(task.id, { workstreamId: null });
    expect((await backend.listTasks())[0].workstreamId).toBeNull();
  });

  it("deletes a task along with its subtasks and events", async () => {
    const task = await backend.createTask("x");
    await backend.createSubtask(task.id, "sub");
    await backend.addTaskEvent(task.id, "note", "hi");

    await backend.deleteTask(task.id);

    expect(await backend.listTasks()).toEqual([]);
    expect(await backend.listTaskEvents()).toEqual([]);
  });
});

describe("labels", () => {
  it("reuses an existing label rather than creating a case variant", async () => {
    const a = await backend.createTask("a");
    const b = await backend.createTask("b");

    await backend.setTaskLabels(a.id, ["AI Crew"]);
    await backend.setTaskLabels(b.id, ["ai crew"]);

    const labels = await backend.listLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0].name).toBe("AI Crew");
  });

  it("attaches the resolved label ids to the task", async () => {
    const task = await backend.createTask("a");
    await backend.setTaskLabels(task.id, ["OfflineSDK", "Bugs/Fixes"]);

    const labels = await backend.listLabels();
    const [stored] = await backend.listTasks();
    expect(stored.labelIds).toHaveLength(2);
    expect(new Set(stored.labelIds)).toEqual(new Set(labels.map((l) => l.id)));
  });

  it("replaces the label set rather than appending", async () => {
    const task = await backend.createTask("a");
    await backend.setTaskLabels(task.id, ["Alpha"]);
    await backend.setTaskLabels(task.id, ["Beta"]);

    const [stored] = await backend.listTasks();
    expect(stored.labelIds).toHaveLength(1);
    const labels = await backend.listLabels();
    expect(labels.find((l) => l.id === stored.labelIds[0])?.name).toBe("Beta");
  });
});

describe("subtasks", () => {
  it("carries a full status, not a checkbox", async () => {
    const task = await backend.createTask("a");
    const sub = await backend.createSubtask(task.id, "review improved version");
    await backend.updateSubtask(sub.id, { status: "in_review" });

    const [stored] = await backend.listTasks();
    expect(stored.subtasks[0].status).toBe("in_review");
  });

  it("keeps subtasks off the board by living only inside their task", async () => {
    const task = await backend.createTask("a");
    await backend.createSubtask(task.id, "sub");
    const tasks = await backend.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subtasks).toHaveLength(1);
  });

  it("deletes a subtask without touching its parent", async () => {
    const task = await backend.createTask("a");
    const sub = await backend.createSubtask(task.id, "sub");
    await backend.deleteSubtask(sub.id);

    const [stored] = await backend.listTasks();
    expect(stored.subtasks).toEqual([]);
  });
});

describe("events", () => {
  it("records a manual note by default", async () => {
    const task = await backend.createTask("a");
    const event = await backend.addTaskEvent(task.id, "note", "picked this back up");
    expect(event.source).toBe("manual");
    expect(event.text).toBe("picked this back up");
  });

  it("records auto events distinctly", async () => {
    const task = await backend.createTask("a");
    await backend.addTaskEvent(task.id, "status", "→ in review", "auto");
    const [event] = await backend.listTaskEvents(task.id);
    expect(event.source).toBe("auto");
  });

  it("offers no way to rewrite an event's text", () => {
    // Immutability is enforced by the absence of an update path, not by a
    // runtime guard -- so this asserts the API surface itself.
    expect((backend as unknown as Record<string, unknown>).updateTaskEvent).toBeUndefined();
  });

  it("allows deleting an event, because a typo must not be permanent", async () => {
    const task = await backend.createTask("a");
    const event = await backend.addTaskEvent(task.id, "note", "typo");
    await backend.deleteTaskEvent(event.id);
    expect(await backend.listTaskEvents(task.id)).toEqual([]);
  });

  it("returns events chronologically", async () => {
    const task = await backend.createTask("a");
    const first = await backend.addTaskEvent(task.id, "note", "one");
    const second = await backend.addTaskEvent(task.id, "note", "two");
    const ids = (await backend.listTaskEvents(task.id)).map((e) => e.id);
    expect(ids).toEqual([first.id, second.id]);
  });

  it("lists across all tasks when no task is given", async () => {
    const a = await backend.createTask("a");
    const b = await backend.createTask("b");
    await backend.addTaskEvent(a.id, "note", "x");
    await backend.addTaskEvent(b.id, "note", "y");
    expect(await backend.listTaskEvents()).toHaveLength(2);
  });
});
