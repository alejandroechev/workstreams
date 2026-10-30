import { describe, it, expect } from "vitest";
import {
  addChange,
  applyDraft,
  candidates,
  daysLeft,
  describeChange,
  draftLabel,
  linkTargets,
  visibleOrphans,
  endedSprintOffer,
  featureSummaries,
  gauge,
  nextTempId,
  orderBetween,
  outOfSprintIteration,
  parseTeamLink,
  resolveOffer,
  sortTasks,
  sprintSummary,
  taskProgress,
  type Change,
  type PlanItem,
  type PlanningData,
  type PlanTask,
} from "../planning";

const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({
  id, rev: 1, kind: "User Story", title: `item ${id}`, state: "New", assigned_to: "Me", assigned_to_me: true,
  iteration_path: "P\\S22", story_points: 1, order: null, target_date: null, parent_id: 100, tasks_done: 0, tasks_total: 0, url: `u/${id}`,
  ...over,
});

function data(items: PlanItem[], selected = "P\\S22"): PlanningData {
  return {
    connection: { organization: "o", project: "P", team: "T", team_id: "t", area_path: "P\\A", backlog_iteration: "P\\CY26", order_field: "o", effort_field: "e" },
    me: { id: "me", display_name: "Me", unique_name: "me@x.com" },
    iterations: [
      { name: "S21", path: "P\\S21", start: "2026-10-12T00:00:00Z", finish: "2026-10-25T00:00:00Z", timeframe: "past" },
      { name: "S22", path: "P\\S22", start: "2026-10-26T00:00:00Z", finish: "2026-11-08T00:00:00Z", timeframe: "current" },
      { name: "S23", path: "P\\S23", start: "2026-11-09T00:00:00Z", finish: "2026-11-22T00:00:00Z", timeframe: "future" },
    ],
    selected_sprint: selected,
    previous_sprint: selected === "P\\S23" ? "P\\S22" : "P\\S21",
    items,
  };
}

const feature = item(100, { kind: "Feature", state: "Active", iteration_path: "P\\Q4", parent_id: null, story_points: null, target_date: "2026-11-22T00:00:00Z", order: 1 });

describe("sprint summary", () => {
  it("counts only my non-Removed stories in the selected sprint", () => {
    const d = data([
      feature,
      item(1, { state: "Closed", story_points: 1 }),
      item(2, { story_points: 3 }),
      item(3, { state: "Active", story_points: 3 }),
      item(4, { story_points: null }),
      item(5, { assigned_to: "Erwin", assigned_to_me: false, story_points: 8 }),
      item(6, { state: "Removed", story_points: 5 }),
      item(7, { iteration_path: "P\\S21", story_points: 2 }),
    ]);
    const s = sprintSummary(d);
    expect(s.stories.map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect([s.committed, s.done, s.toGo, s.notEstimated]).toEqual([7, 1, 6, 1]);
  });
});

describe("feature summaries", () => {
  const d = data([
    feature,
    item(101, { kind: "Feature", state: "Closed", parent_id: null }),
    item(1, { state: "Closed", story_points: 3 }),
    item(2, { state: "Resolved", story_points: 2 }),
    item(3, { story_points: 5 }),
    item(4, { story_points: 8 }),
    item(5, { state: "Active", story_points: null }),
    item(6, { assigned_to: "Erwin", assigned_to_me: false, story_points: 8 }),
    item(7, { state: "Removed", story_points: 5 }),
  ]);

  it("shows done vs pending (Removed left out), what's unestimated, and others' stories", () => {
    const [f] = featureSummaries(d);
    expect(featureSummaries(d)).toHaveLength(1);
    expect([f.done, f.pending, f.myPending, f.notEstimated]).toEqual([5, 21, 13, 1]);
    expect(f.stories.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([f.sprintsLeft, f.atRisk]).toEqual([2, false]);
  });

  it("is at risk when my pending points exceed the sprints left × 8", () => {
    const near = { ...d, items: d.items.map((i) => i.id === 100 ? { ...i, target_date: "2026-11-10T00:00:00Z" } : i) };
    const [f] = featureSummaries(near);
    expect([f.sprintsLeft, f.atRisk]).toEqual([1, true]);
    const none = { ...d, items: d.items.map((i) => i.id === 100 ? { ...i, target_date: null } : i) };
    expect(featureSummaries(none)[0]).toMatchObject({ sprintsLeft: null, atRisk: false });
  });
});

describe("the gauge against 8 story points", () => {
  it("is yellow under 7, green from 7 to 9, orange over 9, and says how far", () => {
    expect([3, 6.5, 7, 8, 9, 9.5, 13].map(gauge)).toEqual([
      { state: "under", text: "5 to go" },
      { state: "under", text: "1.5 to go" },
      { state: "on", text: "On target" },
      { state: "on", text: "On target" },
      { state: "on", text: "On target" },
      { state: "over", text: "1.5 over the goal" },
      { state: "over", text: "5 over the goal" },
    ]);
  });
});

describe("the selected sprint", () => {
  it("counts days left and offers ADO's current sprint once the selected one has ended", () => {
    const d = data([], "P\\S21");
    expect(daysLeft(d.iterations[1], new Date("2026-10-30T12:00:00Z"))).toBe(10);
    expect(daysLeft(d.iterations[0], new Date("2026-10-30T12:00:00Z"))).toBe(0);
    expect(endedSprintOffer(d, new Date("2026-10-30T12:00:00Z"))?.path).toBe("P\\S22");
    expect(endedSprintOffer(data([], "P\\S22"), new Date("2026-10-30T12:00:00Z"))).toBeNull();
  });
});

describe("planning candidates", () => {
  it("lists carry-over first, then my unplanned stories, then unassigned ones in my features, by feature in backlog order", () => {
    const other = item(200, { kind: "Feature", state: "Active", iteration_path: "P\\Q4", parent_id: null, story_points: null, order: 0, title: "Other" });
    const d = data([
      feature, other,
      item(1, { iteration_path: "P\\S22", state: "Active", title: "carried" }),
      item(2, { iteration_path: "P\\Q4", order: 20, title: "b" }),
      item(3, { iteration_path: "P\\Q4", order: 10, title: "a" }),
      item(4, { iteration_path: "P\\Q4", assigned_to: null, assigned_to_me: false, title: "free" }),
      item(5, { iteration_path: "P\\Q4", parent_id: 200, title: "other's" }),
      item(6, { iteration_path: "P\\Q4", state: "Closed" }),
      item(7, { iteration_path: "P\\S23", title: "already in" }),
      item(8, { iteration_path: "P\\Q4", assigned_to: "Erwin", assigned_to_me: false }),
      item(9, { iteration_path: "P\\Q4", parent_id: null, title: "loose" }),
    ], "P\\S23");
    const groups = candidates(d, d.items);
    expect(groups.map((g) => [g.label, g.carryOver, g.stories.map((s) => s.id)])).toEqual([
      ["Carried over", true, [1]],
      ["Other", false, [5]],
      ["item 100", false, [3, 2, 4]],
      ["No feature", false, [9]],
    ]);
  });

  it("sends a story dragged out of the sprint back to its feature's iteration, or the team backlog", () => {
    const d = data([feature, item(1), item(2, { parent_id: null })]);
    expect(outOfSprintIteration(d, d.items, d.items[1])).toBe("P\\Q4");
    expect(outOfSprintIteration(d, d.items, d.items[2])).toBe("P\\CY26");
  });
});

describe("the draft", () => {
  it("keeps the last change per item and kind, and folds edits of new items into their creation", () => {
    let draft: Change[] = [];
    draft = addChange(draft, { kind: "move", id: 2, rev: 1, to_iteration: "S23", assign_to_me: false });
    draft = addChange(draft, { kind: "estimate", id: 2, rev: 1, points: 5 });
    draft = addChange(draft, { kind: "move", id: 2, rev: 1, to_iteration: "S24", assign_to_me: false });
    expect(draft).toHaveLength(2);
    expect(draft[0]).toMatchObject({ to_iteration: "S24" });
    expect(nextTempId(draft)).toBe(-1);
    draft = addChange(draft, { kind: "create_feature", temp_id: -1, title: "F", target_date: null, description: null });
    draft = addChange(draft, { kind: "create_story", temp_id: nextTempId(draft), parent: -1, title: "S", points: 2, description: null });
    draft = addChange(draft, { kind: "estimate", id: -2, rev: 0, points: 3 });
    draft = addChange(draft, { kind: "retitle", id: -2, rev: 0, title: "S2" });
    expect(draft[3]).toMatchObject({ kind: "create_story", points: 3, title: "S2" });
    expect(draftLabel(draft)).toBe("4 changes not published");
    draft = addChange(draft, { kind: "remove", id: -1, rev: 0 });
    expect(draft).toHaveLength(2);
    expect(draftLabel(draft.slice(0, 1))).toBe("1 change not published");
  });

  it("shows the data as it will be after publishing", () => {
    const d = data([feature, item(1), item(2), item(5, { assigned_to: null, assigned_to_me: false, iteration_path: "P\\Q4" })]);
    const draft: Change[] = [
      { kind: "move", id: 1, rev: 1, to_iteration: "P\\S23", assign_to_me: false },
      { kind: "estimate", id: 2, rev: 1, points: 8 },
      { kind: "retitle", id: 2, rev: 1, title: "renamed" },
      { kind: "order", id: 2, rev: 1, order: 5 },
      { kind: "move", id: 5, rev: 1, to_iteration: "P\\S22", assign_to_me: true },
      { kind: "remove", id: 1, rev: 1 },
      { kind: "create_feature", temp_id: -1, title: "New F", target_date: "2027-01-15", description: null },
      { kind: "create_story", temp_id: -2, parent: -1, title: "New S", points: 3, description: null },
      { kind: "create_story", temp_id: -3, parent: 100, title: "Under old", points: null, description: null },
      { kind: "estimate", id: 999, rev: 1, points: 1 },
    ];
    const items = applyDraft(d, draft);
    const by = (id: number) => items.find((i) => i.id === id)!;
    expect(by(1)).toMatchObject({ iteration_path: "P\\S23", state: "Removed" });
    expect(by(2)).toMatchObject({ story_points: 8, title: "renamed", order: 5 });
    expect(by(5)).toMatchObject({ iteration_path: "P\\S22", assigned_to_me: true, assigned_to: "Me" });
    expect(by(-1)).toMatchObject({ kind: "Feature", iteration_path: "P\\CY26", target_date: "2027-01-15" });
    expect(by(-2)).toMatchObject({ kind: "User Story", parent_id: -1, iteration_path: "P\\CY26", story_points: 3 });
    expect(by(-3)).toMatchObject({ iteration_path: "P\\Q4" });
    expect(d.items[1].iteration_path).toBe("P\\S22");
    expect(describeChange(draft[4], d, items)).toBe("Move “item 5” to S22 (and assign to you)");
    expect(draft.map((c) => describeChange(c, d, items))).toHaveLength(10);
  });

  it("plans and orders a story before it exists", () => {
    let draft: Change[] = [{ kind: "create_story", temp_id: -2, parent: 100, title: "S", points: 2, description: null }];
    draft = addChange(draft, { kind: "move", id: -2, rev: 0, to_iteration: "P\\S23", assign_to_me: false });
    draft = addChange(draft, { kind: "order", id: -2, rev: 0, order: 3000 });
    expect(draft).toEqual([{ kind: "create_story", temp_id: -2, parent: 100, title: "S", points: 2, description: null, iteration: "P\\S23", order: 3000 }]);
    const items = applyDraft(data([feature]), draft);
    expect(items.find((i) => i.id === -2)).toMatchObject({ iteration_path: "P\\S23", order: 3000 });
  });

  it("orders between neighbours", () => {
    expect([orderBetween(1, 3), orderBetween(null, 3), orderBetween(1, null), orderBetween(null, null)]).toEqual([2, -997, 1001, 1000]);
  });
});

describe("tasks", () => {
  const task = (id: number, state: string, over: Partial<PlanTask> = {}): PlanTask => ({
    id, rev: 1, title: `task ${id}`, state, assigned_to: "Me", assigned_to_me: true, order: null, url: `u/${id}`, ...over,
  });

  it("are listed by state, then backlog order", () => {
    const sorted = sortTasks([task(1, "Closed"), task(2, "Active", { order: 2 }), task(3, "New"), task(4, "Active", { order: 1 }), task(5, "Blocked"), task(6, "Resolved")]);
    expect(sorted.map((t) => t.id)).toEqual([3, 4, 2, 5, 6, 1]);
  });

  it("take their drafted state, and progress counts it", () => {
    const story = item(2, { state: "Active", tasks: [task(10, "Closed"), task(11, "Active"), task(12, "New")], tasks_done: 1, tasks_total: 3 });
    const d = data([feature, story]);
    let draft: Change[] = [];
    draft = addChange(draft, { kind: "set_state", id: 11, rev: 1, state: "Closed" });
    draft = addChange(draft, { kind: "set_state", id: 11, rev: 1, state: "Resolved" });
    expect(draft).toEqual([{ kind: "set_state", id: 11, rev: 1, state: "Resolved" }]);
    const after = applyDraft(d, draft).find((i) => i.id === 2)!;
    expect(after.tasks!.map((t) => t.state)).toEqual(["New", "Resolved", "Closed"]);
    expect(after.state).toBe("Active");
    expect(taskProgress(after)).toEqual({ done: 2, total: 3 });
    expect(story.tasks![1].state).toBe("Active");
    expect(describeChange(draft[0], d, applyDraft(d, draft))).toBe("Set task “task 11” to Resolved");
    // A story's own state (the resolve offer).
    const resolved = applyDraft(d, [{ kind: "set_state", id: 2, rev: 1, state: "Resolved" }]).find((i) => i.id === 2)!;
    expect(resolved.state).toBe("Resolved");
    expect(describeChange({ kind: "set_state", id: 2, rev: 1, state: "Resolved" }, d, [resolved])).toBe("Set “item 2” to Resolved");
  });

  it("removing and setting a state replace each other, and drafted rows keep the state order", () => {
    let draft: Change[] = [{ kind: "remove", id: 2, rev: 1 }];
    draft = addChange(draft, { kind: "set_state", id: 2, rev: 1, state: "Resolved" });
    expect(draft).toEqual([{ kind: "set_state", id: 2, rev: 1, state: "Resolved" }]);
    draft = addChange(draft, { kind: "remove", id: 2, rev: 1 });
    expect(draft).toEqual([{ kind: "remove", id: 2, rev: 1 }]);
    const story = item(2, { state: "Active", tasks: [task(10, "New"), task(11, "Active")] });
    const after = applyDraft(data([feature, story]), [{ kind: "set_state", id: 10, rev: 1, state: "Closed" }]).find((i) => i.id === 2)!;
    expect(after.tasks!.map((t) => t.id)).toEqual([11, 10]);
  });

  it("offer to resolve a story only once all its tasks are done", () => {
    const story = (state: string, tasks: PlanTask[]) => item(2, { state, tasks });
    expect(resolveOffer(story("Active", [task(1, "Closed"), task(2, "Active")]))).toBe(false);
    expect(resolveOffer(story("Active", [task(1, "Closed"), task(2, "Resolved")]))).toBe(true);
    expect(resolveOffer(story("New", [task(1, "Closed")]))).toBe(true);
    expect(resolveOffer(story("Resolved", [task(1, "Closed")]))).toBe(false);
    expect(resolveOffer(story("Closed", [task(1, "Closed")]))).toBe(false);
    expect(resolveOffer(story("Removed", [task(1, "Closed")]))).toBe(false);
    expect(resolveOffer(story("Active", []))).toBe(false);
    expect(resolveOffer(item(2, { state: "Active" }))).toBe(false);
  });
});

describe("orphaned PRs", () => {
  const pr = (id: number) => ({ id, project_id: "p", repo_id: "r", title: `PR ${id}` });
  it("keeps one pending link per PR, and describes it", () => {
    let draft: Change[] = [];
    draft = addChange(draft, { kind: "link_pr", id: 2, rev: 1, pr: pr(7) });
    draft = addChange(draft, { kind: "link_pr", id: 3, rev: 1, pr: pr(8) });
    draft = addChange(draft, { kind: "link_pr", id: 3, rev: 1, pr: pr(7) });
    expect(draft).toEqual([{ kind: "link_pr", id: 3, rev: 1, pr: pr(7) }, { kind: "link_pr", id: 3, rev: 1, pr: pr(8) }]);
    const d = data([feature, item(3, { title: "Story three" })]);
    expect(applyDraft(d, draft)).toEqual(applyDraft(d, []));
    expect(describeChange(draft[0], d, d.items)).toBe("Link PR “PR 7” to “Story three”");
  });

  it("offers my stories and the tasks of sprint stories as link targets", () => {
    const sprintStory = item(2, { title: "In sprint", rev: 3, tasks: [{ id: 20, rev: 5, title: "A task", state: "Active", assigned_to: "Me", assigned_to_me: true, order: null, url: "" }] });
    const other = item(4, { title: "Feature story", iteration_path: "P\\Q4", assigned_to_me: false, assigned_to: "Erwin" });
    const d = data([feature, sprintStory, other, item(5, { state: "Removed" }), item(6, { kind: "Bug" })]);
    expect(linkTargets(d)).toEqual([
      { id: 2, rev: 3, title: "In sprint", task: false },
      { id: 20, rev: 5, title: "A task", task: true },
      { id: 4, rev: 1, title: "Feature story", task: false },
    ]);
  });

  it("leaves hidden PRs and repos out of the visible list", () => {
    const o = (id: number, repo_id: string) => ({ id, title: `PR ${id}`, project: "SCC", project_id: "s", repo: `SCC/${repo_id}`, repo_id, state: "completed", created: "2026-10-29", url: "" });
    const report = { days: 30, prs: [o(1, "a"), o(2, "a"), o(3, "b")], hidden: { prs: [{ id: "3", label: "PR 3" }], repos: [{ id: "a", label: "SCC/a" }] } };
    expect(visibleOrphans(report)).toEqual([]);
    expect(visibleOrphans({ ...report, hidden: { prs: [], repos: [] } }).map((p) => p.id)).toEqual([1, 2, 3]);
  });
});

describe("team links", () => {
  it("reads sprint, backlog and board links in both host forms, and refuses the rest", () => {
    const want = { organization: "skype", project: "OneWork", team: "Waimea Bay" };
    expect(parseTeamLink("https://skype.visualstudio.com/OneWork/_sprints/taskboard/Waimea%20Bay/OneWork/CY26/H2/Q4/Oct/S22%20(Nov%208)")).toEqual(want);
    expect(parseTeamLink("https://dev.azure.com/skype/OneWork/_backlogs/backlog/Waimea%20Bay/Features")).toEqual(want);
    expect(parseTeamLink("https://dev.azure.com/skype/OneWork/_boards/board/t/Waimea%20Bay/Stories")).toEqual(want);
    for (const bad of ["https://github.com/o/r", "https://dev.azure.com/skype/OneWork/_workitems/edit/1", "nope", "http://dev.azure.com/s/P/_backlogs/backlog/T"]) {
      expect(parseTeamLink(bad)).toBeNull();
    }
  });
});
