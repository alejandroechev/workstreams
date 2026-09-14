import { describe, it, expect } from "vitest";
import {
  compareNames,
  laneColor,
  NO_LANE_COLOR,
  decideUnarchive,
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

describe("decideUnarchive", () => {
  it("opens a workstream that is not archived", () => {
    expect(decideUnarchive({ status: "active", directory: "/w" }, true)).toEqual({
      action: "open",
    });
  });

  it("asks before unarchiving, so a misclick does not mutate state", () => {
    expect(decideUnarchive({ status: "archived", directory: "/w" }, true)).toEqual({
      action: "confirm",
    });
  });

  /**
   * The failure this exists to prevent: archiving offers to delete the
   * worktree, so unarchiving can open a workstream pointing at nothing — the
   * same empty-workspace bug already fixed in ws.create.
   */
  it("offers to recreate when the worktree is gone", () => {
    expect(decideUnarchive({ status: "archived", directory: "/gone" }, false)).toEqual({
      action: "recreate",
      directory: "/gone",
    });
  });

  it("refuses while the archive cleanup is still running", () => {
    const outcome = decideUnarchive({ status: "archiving", directory: "/w" }, true);
    expect(outcome.action).toBe("blocked");
  });

  it("refuses an archived workstream that never had a directory", () => {
    const outcome = decideUnarchive({ status: "archived", directory: null }, true);
    expect(outcome.action).toBe("blocked");
  });
});

describe("laneColor", () => {
  it("gives the unfiled group a neutral grey", () => {
    expect(laneColor(null)).toBe(NO_LANE_COLOR);
    expect(laneColor(undefined)).toBe(NO_LANE_COLOR);
    expect(laneColor("")).toBe(NO_LANE_COLOR);
  });

  it("is stable for the same lane", () => {
    expect(laneColor("lane-1")).toBe(laneColor("lane-1"));
  });

  /**
   * Keyed on the id rather than the name, so renaming a lane keeps the colour
   * you have learned to recognise it by.
   */
  it("does not depend on the lane name", () => {
    const before = laneColor("lane-7");
    // Nothing about the name is an input, so this is really a documentation
    // test: the signature takes only the id.
    expect(laneColor("lane-7")).toBe(before);
  });

  it("spreads consecutive ids across different colours", () => {
    const colors = ["lane-1", "lane-2", "lane-3", "lane-4"].map(laneColor);
    // Sequential ids are the common case (the backend mints them in order), so
    // adjacent lanes must not collide.
    expect(new Set(colors).size).toBeGreaterThan(1);
    expect(colors[0]).not.toBe(colors[1]);
  });

  /**
   * A 2px bar cannot distinguish two blues, so the palette holds only hues that
   * stay separable at that size.
   */
  it("uses only clearly separable hues", () => {
    const palette = new Set(
      Array.from({ length: 200 }, (_, index) => laneColor(`lane-${index}`)),
    );
    // Blue is in; its near-neighbours sapphire and teal are deliberately not.
    expect(palette.has("#89b4fa")).toBe(true);
    expect(palette.has("#74c7ec")).toBe(false);
    expect(palette.has("#94e2d5")).toBe(false);
  });

  it("always returns a colour from the palette", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(laneColor(`lane-${index}`)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
