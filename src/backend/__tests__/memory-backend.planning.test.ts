import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";
import type { PlanItem } from "../../domain/planning";

const story = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({
  id, rev: 1, kind: "User Story", title: `story ${id}`, state: "New", assigned_to: "Me", assigned_to_me: true,
  iteration_path: "OneWork\\S22", story_points: 3, order: null, target_date: null, parent_id: 100, tasks_done: 0, tasks_total: 0, url: "",
  ...over,
});

function seeded() {
  const b = new MemoryBackend();
  b.seedPlanningAdo({
    iterations: [
      { name: "S22", path: "OneWork\\S22", start: "2026-10-26T00:00:00Z", finish: "2026-11-08T00:00:00Z", timeframe: "current" },
      { name: "S23", path: "OneWork\\S23", start: "2026-11-09T00:00:00Z", finish: "2026-11-22T00:00:00Z", timeframe: "future" },
    ],
    items: [
      story(100, { kind: "Feature", state: "Active", iteration_path: "OneWork\\Q4", parent_id: null, story_points: null, target_date: "2026-11-20T00:00:00Z" }),
      story(1),
      story(2, { iteration_path: "OneWork\\Q4" }),
      story(3, { assigned_to: "Erwin", assigned_to_me: false, iteration_path: "OneWork\\Q4" }),
      story(4, { assigned_to: "Erwin", assigned_to_me: false, parent_id: null }),
    ],
  });
  return b;
}
const LINK = "https://skype.visualstudio.com/OneWork/_sprints/taskboard/Waimea%20Bay/OneWork/CY26";

describe("MemoryBackend planning", () => {
  it("connects from a team link, refuses bad ones, and reads like ADO", async () => {
    const b = seeded();
    expect((await b.planningState()).connection).toBeNull();
    await expect(b.planningFetch()).rejects.toThrow("isn't connected");
    await expect(b.planningConnect("https://github.com/o/r")).rejects.toThrow("team sprint or backlog link");
    await expect(b.planningConnect("https://dev.azure.com/skype/OneWork/_backlogs/backlog/Nope/Features")).rejects.toThrow("wasn't found");
    b.setPlanningAuthError(true);
    await expect(b.planningConnect(LINK)).rejects.toThrow("az login");
    b.setPlanningAuthError(false);
    const conn = await b.planningConnect(LINK);
    expect(conn).toMatchObject({ organization: "skype", project: "OneWork", team: "Waimea Bay" });
    const data = await b.planningFetch();
    expect(data.selected_sprint).toBe("OneWork\\S22");
    expect(data.items.map((i) => i.id).sort((a, c) => a - c)).toEqual([1, 2, 3, 100]);
    await b.planningSelectSprint("OneWork\\S23");
    expect((await b.planningFetch()).selected_sprint).toBe("OneWork\\S23");
    expect(b.planningFetchCount()).toBe(2);
  });

  it("keeps a draft, publishes it in order, and holds back only an item changed in ADO", async () => {
    const b = seeded();
    await b.planningConnect(LINK);
    await b.planningAddChange({ kind: "move", id: 2, rev: 1, to_iteration: "OneWork\\S23", assign_to_me: false });
    await b.planningAddChange({ kind: "move", id: 3, rev: 1, to_iteration: "OneWork\\S23", assign_to_me: true });
    await b.planningAddChange({ kind: "estimate", id: 2, rev: 1, points: 5 });
    await b.planningAddChange({ kind: "remove", id: 1, rev: 1 });
    await b.planningAddChange({ kind: "create_story", temp_id: -1, parent: 100, title: "New", points: 2, description: null });
    expect((await b.planningState()).draft).toHaveLength(5);
    expect(b.planningWrites()).toBe(0);
    b.changePlanningItemInAdo(1, { iteration_path: "OneWork\\S24" });
    const result = await b.planningPublish();
    expect(result.conflicts).toEqual([{ id: 1, title: "story 1", field: "System.State", ado_value: "New" }]);
    expect(result.written).toHaveLength(3);
    expect((await b.planningState()).draft).toEqual([{ kind: "remove", id: 1, rev: 1 }]);
    const ado = b.planningAdoItems();
    expect(ado.find((i) => i.id === 2)).toMatchObject({ iteration_path: "OneWork\\S23", story_points: 5 });
    expect(ado.find((i) => i.id === 3)).toMatchObject({ iteration_path: "OneWork\\S23", assigned_to_me: true });
    expect(ado.find((i) => i.title === "New")).toMatchObject({ parent_id: 100, iteration_path: "OneWork\\Q4", story_points: 2, assigned_to_me: true });
    await b.planningSetDraft([]);
    expect((await b.planningState()).draft).toEqual([]);
  });

  it("leaves a retryable draft after a partial failure: new parents and our own revisions carried over", async () => {
    const b = seeded();
    await b.planningConnect(LINK);
    await b.planningAddChange({ kind: "estimate", id: 2, rev: 1, points: 5 });
    await b.planningAddChange({ kind: "retitle", id: 2, rev: 1, title: "Renamed" });
    await b.planningAddChange({ kind: "create_feature", temp_id: -1, title: "F", target_date: null, description: null });
    await b.planningAddChange({ kind: "create_story", temp_id: -2, parent: -1, title: "Child", points: null, description: null });
    b.failPlanningWrite((c) => c.kind === "retitle" || (c.kind === "create_story" && c.title === "Child"));
    const first = await b.planningPublish();
    expect(first.failures).toHaveLength(2);
    const fid = b.planningAdoItems().find((i) => i.title === "F")!.id;
    expect((await b.planningState()).draft).toEqual([
      { kind: "retitle", id: 2, rev: 2, title: "Renamed" },
      { kind: "create_story", temp_id: -2, parent: fid, title: "Child", points: null, description: null },
    ]);
    b.failPlanningWrite(null);
    const retry = await b.planningPublish();
    expect(retry.conflicts).toEqual([]);
    expect(retry.failures).toEqual([]);
    expect(b.planningAdoItems().find((i) => i.id === 2)?.title).toBe("Renamed");
    expect(b.planningAdoItems().find((i) => i.title === "Child")?.parent_id).toBe(fid);
  });

  it("creates a story where and in the order it was planned", async () => {
    const b = seeded();
    await b.planningConnect(LINK);
    await b.planningAddChange({ kind: "create_story", temp_id: -1, parent: 100, title: "New", points: 2, description: null });
    await b.planningAddChange({ kind: "move", id: -1, rev: 0, to_iteration: "OneWork\\S23", assign_to_me: false });
    await b.planningAddChange({ kind: "order", id: -1, rev: 0, order: 3000 });
    await b.planningPublish();
    expect(b.planningAdoItems().find((i) => i.title === "New")).toMatchObject({ iteration_path: "OneWork\\S23", order: 3000 });
  });

  it("remembers the sprint it first defaulted to, so a rollover is offered rather than applied", async () => {
    const b = seeded();
    await b.planningConnect(LINK);
    await b.planningFetch();
    expect((await b.planningState()).selected_sprint).toBe("OneWork\\S22");
  });

  it("refuses draft changes while a publish is running", async () => {
    const b = seeded();
    await b.planningConnect(LINK);
    await b.planningAddChange({ kind: "estimate", id: 2, rev: 1, points: 5 });
    const publishing = b.planningPublish();
    await expect(b.planningAddChange({ kind: "estimate", id: 1, rev: 1, points: 1 })).rejects.toThrow("Publishing");
    await expect(b.planningSetDraft([])).rejects.toThrow("Publishing");
    await publishing;
    await expect(b.planningAddChange({ kind: "estimate", id: 1, rev: 1, points: 1 })).resolves.toHaveLength(1);
  });

  it("refuses a taken new id and a replacement based on a stale draft", async () => {
    const b = seeded();
    await b.planningConnect(LINK);
    const feature = (title: string) => ({ kind: "create_feature" as const, temp_id: -1, title, target_date: null, description: null });
    await b.planningAddChange(feature("From the CLI"));
    await expect(b.planningAddChange(feature("Stale view"))).rejects.toThrow("changed meanwhile");
    await expect(b.planningSetDraft([], [])).rejects.toThrow("changed meanwhile");
    expect((await b.planningState()).draft).toEqual([feature("From the CLI")]);
    await b.planningSetDraft([], [feature("From the CLI")]);
    expect((await b.planningState()).draft).toEqual([]);
  });

  it("lists sprint stories' tasks like ADO, and publishes their states with a revision check", async () => {
    const b = seeded();
    b.seedPlanningAdo({
      iterations: [{ name: "S22", path: "OneWork\\S22", start: "2026-10-26T00:00:00Z", finish: "2026-11-08T00:00:00Z", timeframe: "current" }],
      items: [
        story(1, { state: "Active" }),
        story(10, { kind: "Task", title: "Closed one", state: "Closed", parent_id: 1 }),
        story(11, { kind: "Task", title: "Mine", state: "Active", parent_id: 1, order: 2 }),
        story(12, { kind: "Task", title: "Erwin's", state: "New", parent_id: 1, assigned_to: "Erwin", assigned_to_me: false }),
        story(13, { kind: "Task", title: "Gone", state: "Removed", parent_id: 1 }),
        story(14, { kind: "Bug", title: "A bug", state: "New", parent_id: 1 }),
      ],
    });
    await b.planningConnect(LINK);
    const data = await b.planningFetch();
    expect(data.items.map((i) => i.id)).toEqual([1]);
    const s = data.items[0];
    expect(s.tasks!.map((t) => [t.id, t.state, t.assigned_to])).toEqual([[12, "New", "Erwin"], [11, "Active", "Me"], [10, "Closed", "Me"]]);
    expect([s.tasks_done, s.tasks_total]).toEqual([1, 3]);
    await expect(b.planningAddChange({ kind: "set_state", id: 11, rev: 1, state: "Removed" })).rejects.toThrow("New, Active, Blocked, Resolved or Closed");
    await b.planningAddChange({ kind: "set_state", id: 11, rev: 1, state: "Closed" });
    await b.planningAddChange({ kind: "set_state", id: 12, rev: 1, state: "Active" });
    b.changePlanningItemInAdo(12, { state: "Blocked" });
    const result = await b.planningPublish();
    expect(result.conflicts).toEqual([{ id: 12, title: "Erwin's", field: "System.State", ado_value: "Blocked" }]);
    const ado = b.planningAdoItems();
    expect([ado.find((i) => i.id === 11)?.state, ado.find((i) => i.id === 12)?.state]).toEqual(["Closed", "Blocked"]);
    expect((await b.planningState()).draft).toEqual([{ kind: "set_state", id: 12, rev: 1, state: "Active" }]);
  });

  it("can fail a read, as a network error would", async () => {
    const b = seeded();
    await b.planningConnect(LINK);
    b.failPlanningFetch(true);
    await expect(b.planningFetch()).rejects.toThrow("timed out");
  });
});
