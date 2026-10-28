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

  it("can fail a read, as a network error would", async () => {
    const b = seeded();
    await b.planningConnect(LINK);
    b.failPlanningFetch(true);
    await expect(b.planningFetch()).rejects.toThrow("timed out");
  });
});
