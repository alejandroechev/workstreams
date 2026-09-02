import { describe, it, expect } from "vitest";
import {
  groupByColumn,
  swimlanes,
  visibleTasks,
  filterByRepo,
  UNLABELLED_LANE_ID,
  statusForDrop,
  subtaskProgress,
  cardSubtasks,
  inProgressTasks,
} from "../task-board";
import { makeTask, makeEvent } from "../tasks";
import type { Task, Label, TaskEvent } from "../tasks";
import type { Workstream } from "../types";
import { BOARD_COLUMNS } from "../task-status";

const LABELS: Label[] = [
  { id: "l1", name: "OfflineSDK", color: "#89b4fa" },
  { id: "l2", name: "AI Crew", color: "#f38ba8" },
];

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

/**
 * The measured shape of the real board: 61 tasks, 45 of them in_progress.
 * Toy fixtures would hide the very skew these selectors exist to fix.
 */
function realShapedBoard(): Task[] {
  const tasks: Task[] = [];
  for (let i = 0; i < 45; i++) {
    tasks.push(
      makeTask({
        id: `p${i}`,
        title: `in progress ${i}`,
        status: "in_progress",
        labelIds: [i % 2 === 0 ? "l1" : "l2"],
      }),
    );
  }
  for (let i = 0; i < 6; i++) {
    tasks.push(makeTask({ id: `r${i}`, title: `review ${i}`, status: "in_review", labelIds: ["l1"] }));
  }
  for (let i = 0; i < 5; i++) {
    tasks.push(makeTask({ id: `b${i}`, title: `blocked ${i}`, status: "blocked", labelIds: ["l2"] }));
  }
  for (let i = 0; i < 5; i++) {
    tasks.push(makeTask({ id: `t${i}`, title: `todo ${i}`, status: "todo", labelIds: [] }));
  }
  return tasks;
}

describe("groupByColumn", () => {
  it("returns a bucket for every column even when empty", () => {
    const grouped = groupByColumn([]);
    expect(Object.keys(grouped).sort()).toEqual(BOARD_COLUMNS.map((c) => c.id).sort());
  });

  it("reproduces the real skew rather than hiding it", () => {
    const grouped = groupByColumn(realShapedBoard());
    expect(grouped.in_progress).toHaveLength(45);
    expect(grouped.todo).toHaveLength(5);
    expect(grouped.done).toHaveLength(0);
  });

  it("places investigating in the in_progress column", () => {
    const grouped = groupByColumn([makeTask({ id: "a", title: "x", status: "investigating" })]);
    expect(grouped.in_progress.map((t) => t.id)).toEqual(["a"]);
  });

  it("places cancelled in the done column", () => {
    const grouped = groupByColumn([makeTask({ id: "a", title: "x", status: "cancelled" })]);
    expect(grouped.done.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("swimlanes", () => {
  it("breaks a 45-card column into short scannable lanes", () => {
    const lanes = swimlanes(realShapedBoard(), LABELS);
    const inProgress = lanes.map((lane) => lane.columns.in_progress.length);
    expect(Math.max(...inProgress)).toBeLessThan(45);
    expect(inProgress.reduce((a, b) => a + b, 0)).toBe(45);
  });

  it("gives unlabelled tasks their own lane rather than dropping them", () => {
    const lanes = swimlanes(realShapedBoard(), LABELS);
    const orphan = lanes.find((l) => l.id === UNLABELLED_LANE_ID);
    expect(orphan?.columns.todo).toHaveLength(5);
  });

  it("shows a multi-labelled task in every one of its lanes", () => {
    // Multi-valued labels are the whole reason a single project pointer was
    // rejected -- a task can genuinely belong to two areas at once.
    const task = makeTask({ id: "a", title: "x", status: "in_progress", labelIds: ["l1", "l2"] });
    const lanes = swimlanes([task], LABELS);
    const withTask = lanes.filter((l) => l.columns.in_progress.some((t) => t.id === "a"));
    expect(withTask.map((l) => l.id).sort()).toEqual(["l1", "l2"]);
  });

  it("omits lanes with no tasks at all", () => {
    const lanes = swimlanes([makeTask({ id: "a", title: "x", labelIds: ["l1"] })], LABELS);
    expect(lanes.map((l) => l.id)).toEqual(["l1"]);
  });
});

describe("visibleTasks", () => {
  const today = "2026-08-19";
  const doneToday = makeTask({
    id: "d1",
    title: "finished today",
    status: "done",
    completedAt: new Date(2026, 7, 19, 10, 0, 0).toISOString(),
  });
  const doneYesterday = makeTask({
    id: "d2",
    title: "finished yesterday",
    status: "done",
    completedAt: new Date(2026, 7, 18, 10, 0, 0).toISOString(),
  });
  const cancelledYesterday = makeTask({
    id: "c1",
    title: "dropped yesterday",
    status: "cancelled",
    completedAt: new Date(2026, 7, 18, 10, 0, 0).toISOString(),
  });
  const open = makeTask({ id: "o1", title: "still going", status: "in_progress" });

  it("hides work finished before today so Done does not become a graveyard", () => {
    const ids = visibleTasks([doneToday, doneYesterday, open], today).map((t) => t.id);
    expect(ids).toEqual(["d1", "o1"]);
  });

  it("hides cancelled work on the same rule as done", () => {
    const ids = visibleTasks([cancelledYesterday, open], today).map((t) => t.id);
    expect(ids).toEqual(["o1"]);
  });

  it("shows everything when the show-all toggle is on", () => {
    const ids = visibleTasks([doneToday, doneYesterday, open], today, { showAllDone: true }).map(
      (t) => t.id,
    );
    expect(ids).toEqual(["d1", "d2", "o1"]);
  });

  it("keeps a terminal task with no timestamp visible rather than losing it", () => {
    // A missing completedAt is a data defect; silently hiding the task would
    // make it unrecoverable from the UI.
    const orphan = makeTask({ id: "x", title: "x", status: "done", completedAt: null });
    expect(visibleTasks([orphan], today).map((t) => t.id)).toEqual(["x"]);
  });

  it("never hides open work regardless of age", () => {
    const old = makeTask({ id: "old", title: "x", status: "blocked" });
    expect(visibleTasks([old], today).map((t) => t.id)).toEqual(["old"]);
  });
});

describe("filterByRepo", () => {
  const workstreams = [ws("w1", "repo-a"), ws("w2", "repo-b"), ws("w3", null)];
  const attached = makeTask({ id: "a", title: "x", workstreamId: "w1" });
  const other = makeTask({ id: "b", title: "y", workstreamId: "w2" });
  const detached = makeTask({ id: "c", title: "z" });

  it("filters by the repo derived from the workstream", () => {
    const ids = filterByRepo([attached, other, detached], workstreams, "repo-a").map((t) => t.id);
    expect(ids).toEqual(["a"]);
  });

  it("returns everything when no repo is selected", () => {
    expect(filterByRepo([attached, other, detached], workstreams, null)).toHaveLength(3);
  });

  it("excludes tasks with no workstream when a repo is selected", () => {
    // Six of the 21 real sections have no repo, so they must not silently
    // appear under whichever repo happens to be filtered.
    const ids = filterByRepo([detached], workstreams, "repo-a").map((t) => t.id);
    expect(ids).toEqual([]);
  });
});

describe("touched markers", () => {
  it("marks only the handful of tasks that saw activity today", () => {
    const tasks = [makeTask({ id: "a", title: "a" }), makeTask({ id: "b", title: "b" })];
    const events: TaskEvent[] = [
      makeEvent({ id: "e1", taskId: "a", kind: "note", text: "x", at: new Date(2026, 7, 19, 9).toISOString() }),
    ];
    const lanes = swimlanes(tasks, [], { events, today: "2026-08-19" });
    const all = lanes.flatMap((l) => Object.values(l.columns).flat());
    expect(all.find((t) => t.id === "a")?.touchedToday).toBe(true);
    expect(all.find((t) => t.id === "b")?.touchedToday).toBe(false);
  });
});

describe("statusForDrop", () => {
  it("returns the target column's status for a normal move", () => {
    const task = makeTask({ id: "a", title: "x", status: "todo" });
    expect(statusForDrop(task, "in_progress")).toBe("in_progress");
  });

  it("is a no-op when the card is dropped back on its own column", () => {
    const task = makeTask({ id: "a", title: "x", status: "in_review" });
    expect(statusForDrop(task, "in_review")).toBeNull();
  });

  it("preserves investigating when dropped on the column it already renders in", () => {
    // `investigating` renders in the in_progress column. Flattening it to
    // plain `in_progress` on a no-op drag would silently destroy the
    // distinction the archive actually uses.
    const task = makeTask({ id: "a", title: "x", status: "investigating" });
    expect(statusForDrop(task, "in_progress")).toBeNull();
  });

  it("preserves cancelled when dropped on the Done column it already sits in", () => {
    const task = makeTask({ id: "a", title: "x", status: "cancelled" });
    expect(statusForDrop(task, "done")).toBeNull();
  });

  it("still moves investigating out to a genuinely different column", () => {
    const task = makeTask({ id: "a", title: "x", status: "investigating" });
    expect(statusForDrop(task, "blocked")).toBe("blocked");
  });

  it("moves a finished task back into open work", () => {
    const task = makeTask({ id: "a", title: "x", status: "done" });
    expect(statusForDrop(task, "in_progress")).toBe("in_progress");
  });
});

describe("subtaskProgress", () => {
  it("counts only terminal subtasks as finished", () => {
    const task = makeTask({
      id: "a",
      title: "x",
      subtasks: [
        { id: "s1", title: "one", status: "done" },
        { id: "s2", title: "two", status: "cancelled" },
        { id: "s3", title: "three", status: "in_progress" },
      ],
    });
    expect(subtaskProgress(task)).toEqual({ done: 2, total: 3 });
  });

  it("reports zeroes for a task with no subtasks", () => {
    expect(subtaskProgress(makeTask({ id: "a", title: "x" }))).toEqual({ done: 0, total: 0 });
  });
});

describe("cardSubtasks", () => {
  const withSubs = (statuses: string[]) =>
    makeTask({
      id: "a",
      title: "x",
      subtasks: statuses.map((status, i) => ({
        id: `s${i + 1}`,
        title: `sub ${i + 1}`,
        status: status as Task["status"],
      })),
    });

  it("drops finished subtasks from the card list", () => {
    const result = cardSubtasks(withSubs(["done", "in_progress", "cancelled"]), 5);
    expect(result.shown.map((s) => s.id)).toEqual(["s2"]);
    expect(result.hidden).toBe(0);
  });

  it("returns nothing when every subtask is finished", () => {
    expect(cardSubtasks(withSubs(["done", "cancelled"]), 5)).toEqual({ shown: [], hidden: 0 });
  });

  it("returns nothing for a task with no subtasks", () => {
    expect(cardSubtasks(makeTask({ id: "a", title: "x" }), 5)).toEqual({ shown: [], hidden: 0 });
  });

  it("counts overflow from open subtasks only", () => {
    const result = cardSubtasks(withSubs(["done", "todo", "todo", "todo", "done", "todo"]), 2);
    expect(result.shown.map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(result.hidden).toBe(2);
  });
});

describe("inProgressTasks", () => {
  it("selects only tasks that render in the In progress column", () => {
    const tasks = [
      makeTask({ id: "a", title: "doing", status: "in_progress" }),
      makeTask({ id: "b", title: "waiting", status: "blocked" }),
      makeTask({ id: "c", title: "later", status: "todo" }),
    ];
    expect(inProgressTasks(tasks).map((t) => t.id)).toEqual(["a"]);
  });

  it("includes statuses that fold into that column", () => {
    // `investigating` and the retired `persistent` both render there, so an
    // always-on view that dropped them would hide live work.
    const tasks = [
      makeTask({ id: "a", title: "digging", status: "investigating" }),
      makeTask({ id: "b", title: "ongoing", status: "persistent" }),
    ];
    expect(inProgressTasks(tasks).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("excludes finished work even on its completion day", () => {
    const tasks = [
      makeTask({ id: "a", title: "done", status: "done", completedAt: new Date().toISOString() }),
    ];
    expect(inProgressTasks(tasks)).toEqual([]);
  });

  it("preserves board order", () => {
    const tasks = [
      makeTask({ id: "a", title: "first", status: "in_progress" }),
      makeTask({ id: "b", title: "second", status: "in_progress" }),
    ];
    expect(inProgressTasks(tasks).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list rather than everything when nothing is in progress", () => {
    expect(inProgressTasks([makeTask({ id: "a", title: "x", status: "todo" })])).toEqual([]);
  });
});
