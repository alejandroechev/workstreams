import { describe, it, expect } from "vitest";
import {
  makeTask,
  makeEvent,
  completionDate,
  derivedRepoIds,
  touchedOn,
  eventsForTask,
  sortEvents,
  attachWorkstream,
  toLocalDate,
} from "../tasks";
import type { Task, TaskEvent } from "../tasks";
import type { Workstream } from "../types";

function ws(id: string, projectId: string | null): Workstream {
  return {
    id,
    name: id,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: projectId,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

describe("makeTask", () => {
  it("creates a task with no workstream, because most tasks have none", () => {
    const t = makeTask({ title: "media_store read API" });
    expect(t.workstreamId).toBeNull();
    expect(t.status).toBe("todo");
    expect(t.labelIds).toEqual([]);
    expect(t.flags).toEqual([]);
    expect(t.subtasks).toEqual([]);
  });

  it("keeps the caller's id when one is supplied", () => {
    expect(makeTask({ id: "t1", title: "x" }).id).toBe("t1");
  });
});

describe("attachWorkstream", () => {
  it("attaches and detaches, since the link is optional in both directions", () => {
    const t = makeTask({ id: "t1", title: "x" });
    expect(attachWorkstream(t, "w1").workstreamId).toBe("w1");
    expect(attachWorkstream(t, null).workstreamId).toBeNull();
  });

  it("replaces rather than accumulates -- a task has at most one workstream", () => {
    const t = attachWorkstream(makeTask({ id: "t1", title: "x" }), "w1");
    expect(attachWorkstream(t, "w2").workstreamId).toBe("w2");
  });

  it("does not mutate the input task", () => {
    const t = makeTask({ id: "t1", title: "x" });
    attachWorkstream(t, "w1");
    expect(t.workstreamId).toBeNull();
  });
});

describe("derivedRepoIds", () => {
  const workstreams = [ws("w1", "repo-a"), ws("w2", null)];

  it("derives the repo from the attached workstream rather than storing it", () => {
    const t = attachWorkstream(makeTask({ id: "t1", title: "x" }), "w1");
    expect(derivedRepoIds(t, workstreams)).toEqual(["repo-a"]);
  });

  it("returns nothing for a task with no workstream", () => {
    // Six of the 21 real devlog sections have no repo at all, which is why a
    // repo can never be a required field on the task.
    expect(derivedRepoIds(makeTask({ id: "t1", title: "x" }), workstreams)).toEqual([]);
  });

  it("returns nothing when the workstream itself has no repo", () => {
    const t = attachWorkstream(makeTask({ id: "t1", title: "x" }), "w2");
    expect(derivedRepoIds(t, workstreams)).toEqual([]);
  });

  it("returns nothing when the attached workstream is gone", () => {
    const t = attachWorkstream(makeTask({ id: "t1", title: "x" }), "missing");
    expect(derivedRepoIds(t, workstreams)).toEqual([]);
  });
});

describe("toLocalDate", () => {
  it("reports the local calendar day, not the UTC one", () => {
    // A note typed at 21:00 in a negative-offset zone is 01:00Z the next day.
    // Slicing the UTC string would file it on tomorrow's devlog page.
    const local = new Date(2026, 7, 19, 21, 30, 0);
    expect(toLocalDate(local.toISOString())).toBe("2026-08-19");
  });

  it("handles the first minute of a local day", () => {
    const local = new Date(2026, 7, 19, 0, 5, 0);
    expect(toLocalDate(local.toISOString())).toBe("2026-08-19");
  });

  it("falls back to a prefix slice rather than throwing on junk", () => {
    expect(toLocalDate("not-a-date")).toBe("not-a-date");
  });
});

describe("completionDate", () => {
  it("reports the day a task reached a terminal status", () => {
    const at = new Date(2026, 7, 19, 14, 5, 0).toISOString();
    const t: Task = { ...makeTask({ id: "t1", title: "x" }), status: "done", completedAt: at };
    expect(completionDate(t)).toBe("2026-08-19");
  });

  it("reports the day for cancelled too, not just done", () => {
    const at = new Date(2026, 7, 18, 9, 0, 0).toISOString();
    const t: Task = { ...makeTask({ id: "t1", title: "x" }), status: "cancelled", completedAt: at };
    expect(completionDate(t)).toBe("2026-08-18");
  });

  it("returns null while the task is still open", () => {
    expect(completionDate(makeTask({ id: "t1", title: "x" }))).toBeNull();
  });

  it("returns null when a terminal task has no timestamp", () => {
    const t: Task = { ...makeTask({ id: "t1", title: "x" }), status: "done", completedAt: null };
    expect(completionDate(t)).toBeNull();
  });
});

describe("events", () => {
  const events: TaskEvent[] = [
    makeEvent({ id: "e1", taskId: "t1", kind: "note", text: "later", at: new Date(2026, 7, 19, 14, 0, 0).toISOString(), source: "manual" }),
    makeEvent({ id: "e2", taskId: "t1", kind: "status", text: "→ in review", at: new Date(2026, 7, 19, 9, 0, 0).toISOString(), source: "auto" }),
    makeEvent({ id: "e3", taskId: "t2", kind: "note", text: "other task", at: new Date(2026, 7, 18, 9, 0, 0).toISOString(), source: "manual" }),
  ];

  it("defaults an event to manual, since typed notes are the common case", () => {
    expect(makeEvent({ taskId: "t1", kind: "note", text: "hi" }).source).toBe("manual");
  });

  it("selects only a task's own events", () => {
    expect(eventsForTask(events, "t1").map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });

  it("sorts chronologically so the feed reads as a log", () => {
    expect(sortEvents(eventsForTask(events, "t1")).map((e) => e.id)).toEqual(["e2", "e1"]);
  });

  it("does not mutate the array it sorts", () => {
    const input = eventsForTask(events, "t1");
    const before = input.map((e) => e.id);
    sortEvents(input);
    expect(input.map((e) => e.id)).toEqual(before);
  });

  it("finds the tasks touched on a given day", () => {
    // Only ~11 of 61 tasks get an event on a given day; this is what drives
    // the `touched today` marker in the exported page.
    const tasks = [makeTask({ id: "t1", title: "a" }), makeTask({ id: "t2", title: "b" })];
    expect(touchedOn(tasks, events, "2026-08-19").map((t) => t.id)).toEqual(["t1"]);
    expect(touchedOn(tasks, events, "2026-08-17")).toEqual([]);
  });
});
