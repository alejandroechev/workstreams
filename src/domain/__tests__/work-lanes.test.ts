import { describe, it, expect } from "vitest";
import {
  compareNames,
  matchesFilter,
  LIST_FILTERS,
  type ListFilter,
  groupByLane,
  laneKey,
  laneLabel,
  NO_LANE_ID,
  NO_LANE_LABEL,
  type WorkLane,
} from "../work-lanes";
import type { Workstream } from "../types";

const ws = (id: string, name: string, lane_id: string | null = null): Workstream => ({
  id,
  name,
  description: null,
  directory: null,
  git_repo: null,
  git_branch: null,
  status: "active",
  project_id: null,
  workstream_type: "standalone",
  worktree_branch: null,
  lane_id,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
});

const lane = (id: string, name: string): WorkLane => ({ id, name });

describe("compareNames", () => {
  it("ignores case, so lowercase names are not filed in a second alphabet", () => {
    // Case-sensitive ordering would put every lowercase repo name after every
    // capitalised one, which is not how anyone reads a list.
    const names = ["Zebra", "media_components", "Alpha"].sort(compareNames);
    expect(names).toEqual(["Alpha", "media_components", "Zebra"]);
  });

  it("sorts embedded numbers numerically", () => {
    const names = ["PR 10", "PR 9", "PR 100"].sort(compareNames);
    expect(names).toEqual(["PR 9", "PR 10", "PR 100"]);
  });

  it("handles accented names without crashing or mis-filing them", () => {
    const names = ["Zoe", "Émile", "Alice"].sort(compareNames);
    expect(names[0]).toBe("Alice");
    expect(names).toContain("Émile");
  });
});

describe("groupByLane", () => {
  it("nests workstreams under their lane, sorted by name", () => {
    const lanes = [lane("l1", "Media Store")];
    const groups = groupByLane(
      [ws("b", "beta", "l1"), ws("a", "Alpha", "l1")],
      lanes,
    );
    expect(groups[0].lane?.name).toBe("Media Store");
    expect(groups[0].workstreams.map((w) => w.name)).toEqual(["Alpha", "beta"]);
  });

  it("sorts lanes by name but always puts No lane last", () => {
    const lanes = [lane("l2", "Tooling"), lane("l1", "Media Store")];
    const groups = groupByLane([ws("a", "Alpha")], lanes);
    expect(groups.map((g) => laneLabel(g))).toEqual([
      "Media Store",
      "Tooling",
      NO_LANE_LABEL,
    ]);
  });

  /**
   * The property the whole feature leans on: "No lane" is the drop target for
   * removing a workstream from a lane, so it cannot vanish when it is empty.
   */
  it("keeps an empty No lane group, because it is the drop target for removal", () => {
    const groups = groupByLane([ws("a", "Alpha", "l1")], [lane("l1", "Media Store")]);
    const unfiled = groups[groups.length - 1];
    expect(unfiled.lane).toBeNull();
    expect(unfiled.workstreams).toEqual([]);
    expect(laneKey(unfiled)).toBe(NO_LANE_ID);
  });

  it("keeps an empty lane, so the caller can decide whether to show it", () => {
    const groups = groupByLane([], [lane("l1", "Media Store")]);
    expect(groups).toHaveLength(2);
    expect(groups[0].workstreams).toEqual([]);
  });

  /**
   * A stale lane reference must never make a workstream invisible — losing one
   * from the sidebar is far worse than filing it in the wrong place.
   */
  it("treats a workstream pointing at a deleted lane as unfiled", () => {
    const groups = groupByLane([ws("a", "Alpha", "gone")], [lane("l1", "Media Store")]);
    const unfiled = groups[groups.length - 1];
    expect(unfiled.workstreams.map((w) => w.id)).toEqual(["a"]);
  });

  it("does not mutate its inputs", () => {
    const workstreams = [ws("b", "beta", "l1"), ws("a", "Alpha", "l1")];
    const lanes = [lane("l2", "Tooling"), lane("l1", "Media Store")];
    groupByLane(workstreams, lanes);
    expect(workstreams.map((w) => w.id)).toEqual(["b", "a"]);
    expect(lanes.map((l) => l.id)).toEqual(["l2", "l1"]);
  });

  it("returns only No lane when there are no lanes at all", () => {
    const groups = groupByLane([ws("a", "Alpha")], []);
    expect(groups).toHaveLength(1);
    expect(laneLabel(groups[0])).toBe(NO_LANE_LABEL);
  });
});

describe("matchesFilter", () => {
  const withStatus = (status: Workstream["status"]) => ({ ...ws("a", "Alpha"), status });
  const loaded = new Set(["a"]);

  it("loaded means tiles are open, which is narrower than not archived", () => {
    const active = withStatus("active");
    expect(matchesFilter(active, "loaded", loaded)).toBe(true);
    expect(matchesFilter(active, "loaded", new Set())).toBe(false);
    // Same workstream, same status — only the runtime fact differs.
    expect(matchesFilter(active, "not_archived", new Set())).toBe(true);
  });

  it("hides archived until All", () => {
    for (const status of ["archived", "archiving"] as const) {
      const row = withStatus(status);
      expect(matchesFilter(row, "loaded", loaded)).toBe(false);
      expect(matchesFilter(row, "not_archived", loaded)).toBe(false);
      expect(matchesFilter(row, "all", loaded)).toBe(true);
    }
  });

  /**
   * The regression this guards: `create_failed` is the state that most needs
   * action and has no other signal. A filter that hid it would make a broken
   * workstream silently disappear.
   */
  it("never hides creating or create_failed, under any filter", () => {
    for (const status of ["creating", "create_failed"] as const) {
      for (const filter of LIST_FILTERS) {
        expect(
          matchesFilter(withStatus(status), filter, new Set()),
          `${status} under ${filter}`,
        ).toBe(true);
      }
    }
  });

  it("covers every status without throwing", () => {
    const statuses: Workstream["status"][] = [
      "active",
      "working",
      "blocked",
      "in_review",
      "archived",
      "creating",
      "create_failed",
      "archiving",
    ];
    for (const status of statuses) {
      for (const filter of LIST_FILTERS) {
        expect(typeof matchesFilter(withStatus(status), filter, loaded)).toBe("boolean");
      }
    }
  });

  it("treats a missing loaded set as nothing loaded", () => {
    expect(matchesFilter(ws("a", "Alpha"), "loaded", undefined)).toBe(false);
    expect(matchesFilter(ws("a", "Alpha"), "not_archived", undefined)).toBe(true);
  });

  it("exposes exactly three stops", () => {
    const stops: ListFilter[] = [...LIST_FILTERS];
    expect(stops).toEqual(["loaded", "not_archived", "all"]);
  });
});
