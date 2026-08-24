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
  previousLocalDate,
  eventsOnDate,
  previousWorkDay,
  isWeekend,
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

describe("previousLocalDate", () => {
  it("returns the day before the given local instant", () => {
    // The export runs at the start of the next day, covering the day just
    // finished -- so "yesterday" is the unit of work, not "today".
    expect(previousLocalDate(new Date(2026, 7, 20, 9, 30).toISOString())).toBe("2026-08-19");
  });

  it("rolls back across a month boundary", () => {
    expect(previousLocalDate(new Date(2026, 8, 1, 9, 0).toISOString())).toBe("2026-08-31");
  });

  it("rolls back across a year boundary", () => {
    expect(previousLocalDate(new Date(2026, 0, 1, 9, 0).toISOString())).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    expect(previousLocalDate(new Date(2028, 2, 1, 9, 0).toISOString())).toBe("2028-02-29");
  });

  it("uses the local day, not the UTC one", () => {
    // Exporting at 00:30 local must still mean "the day that just ended",
    // even though that instant is already the following day in UTC for
    // negative offsets.
    const lateNight = new Date(2026, 7, 20, 0, 30);
    expect(previousLocalDate(lateNight.toISOString())).toBe("2026-08-19");
  });
});

describe("eventsOnDate", () => {
  const onDay = makeEvent({
    id: "e1",
    taskId: "t1",
    kind: "note",
    text: "that day",
    at: new Date(2026, 7, 19, 14, 0).toISOString(),
  });
  const nextDay = makeEvent({
    id: "e2",
    taskId: "t1",
    kind: "note",
    text: "the day after",
    at: new Date(2026, 7, 20, 9, 0).toISOString(),
  });

  it("keeps only the entries from the given local day", () => {
    expect(eventsOnDate([onDay, nextDay], "2026-08-19").map((e) => e.id)).toEqual(["e1"]);
  });

  it("uses the local day, so a late-evening note stays on the day it was typed", () => {
    // 21:00 in a negative-offset zone is already tomorrow in UTC; slicing the
    // stored string would file it under the wrong day.
    const lateNight = makeEvent({
      id: "e3",
      taskId: "t1",
      kind: "note",
      text: "late",
      at: new Date(2026, 7, 19, 21, 30).toISOString(),
    });
    expect(eventsOnDate([lateNight], "2026-08-19").map((e) => e.id)).toEqual(["e3"]);
  });

  it("returns an empty list rather than everything when nothing matches", () => {
    expect(eventsOnDate([onDay], "2026-01-01")).toEqual([]);
  });

  it("preserves order", () => {
    expect(eventsOnDate([onDay, nextDay, onDay], "2026-08-19")).toHaveLength(2);
  });
});

describe("previousWorkDay", () => {
  // Local construction throughout: a UTC-built date shifts the weekday in
  // negative-offset zones and would silently test the wrong day.
  const on = (y: number, m: number, d: number) => new Date(y, m, d, 9, 0).toISOString();

  it("skips back over the weekend from a Monday", () => {
    // Mon 2026-08-24 → Fri 2026-08-21. Exporting on Monday must write up
    // Friday, not an empty Sunday.
    expect(previousWorkDay(on(2026, 7, 24))).toBe("2026-08-21");
  });

  it("returns the previous day midweek", () => {
    expect(previousWorkDay(on(2026, 7, 20))).toBe("2026-08-19");
  });

  it("returns Friday when run on a Saturday", () => {
    expect(previousWorkDay(on(2026, 7, 22))).toBe("2026-08-21");
  });

  it("returns Friday when run on a Sunday", () => {
    expect(previousWorkDay(on(2026, 7, 23))).toBe("2026-08-21");
  });

  it("returns Thursday when run on a Friday", () => {
    expect(previousWorkDay(on(2026, 7, 21))).toBe("2026-08-20");
  });

  it("crosses a month boundary", () => {
    expect(previousWorkDay(on(2026, 8, 1))).toBe("2026-08-31");
  });

  it("crosses a year boundary", () => {
    expect(previousWorkDay(on(2027, 0, 1))).toBe("2026-12-31");
  });

  it("crosses a month boundary that lands on a weekend", () => {
    // Mon 2026-06-01 → Fri 2026-05-29, skipping both the weekend and the
    // month end in one step.
    expect(previousWorkDay(on(2026, 5, 1))).toBe("2026-05-29");
  });
});

describe("isWeekend", () => {
  it("recognises Saturday and Sunday", () => {
    expect(isWeekend("2026-08-22")).toBe(true);
    expect(isWeekend("2026-08-23")).toBe(true);
  });

  it("treats weekdays as work days", () => {
    for (const d of ["2026-08-21", "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27"]) {
      expect(isWeekend(d)).toBe(false);
    }
  });
});
