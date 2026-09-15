import { describe, it, expect } from "vitest";
import { restorableLoadedIds, visiblyLoadedIds } from "../loaded-workstreams";
import type { Workstream, WorkstreamStatus } from "../types";

function ws(
  id: string,
  over: { is_loaded?: boolean; status?: WorkstreamStatus } = {},
): Workstream {
  return {
    id,
    name: id,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: over.status ?? "active",
    project_id: null,
    workstream_type: "standalone",
    worktree_branch: null,
    is_loaded: over.is_loaded,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("restorableLoadedIds", () => {
  it("restores the workstreams that were open", () => {
    const ids = restorableLoadedIds([
      ws("a", { is_loaded: true }),
      ws("b"),
      ws("c", { is_loaded: true }),
    ]);
    expect([...ids].sort()).toEqual(["a", "c"]);
  });

  it("treats a missing flag as not loaded", () => {
    // Rows written before the column existed, and every fixture in the suite.
    expect(restorableLoadedIds([ws("a")]).size).toBe(0);
  });

  /**
   * Archiving is how you put something away. A workstream that reappears
   * loaded on the next launch has not been put away -- and the flag really can
   * still be set, because archiving something you had open is normal.
   */
  it("does not restore an archived workstream even if the flag is set", () => {
    const ids = restorableLoadedIds([ws("a", { is_loaded: true, status: "archived" })]);
    expect(ids.size).toBe(0);
  });

  it("does not restore workstreams mid-provisioning", () => {
    // Their directory may not exist yet, or may be being deleted.
    for (const status of ["creating", "create_failed", "archiving"] as const) {
      const ids = restorableLoadedIds([ws("a", { is_loaded: true, status })]);
      expect(ids.size, status).toBe(0);
    }
  });

  it("still restores the other user-facing statuses", () => {
    for (const status of ["active", "working", "blocked", "in_review"] as const) {
      const ids = restorableLoadedIds([ws("a", { is_loaded: true, status })]);
      expect(ids.size, status).toBe(1);
    }
  });
});

describe("visiblyLoadedIds", () => {
  /**
   * The reason the split exists. A restored workstream has no mounted tiles
   * until it is visited, so deriving "loaded" from the mounted map alone would
   * make persistence invisible until the user clicked every row.
   */
  it("shows a restored workstream as loaded before anything is mounted", () => {
    const ids = visiblyLoadedIds(new Set(["a"]), []);
    expect(ids.has("a")).toBe(true);
  });

  it("shows a mounted workstream as loaded even if it was not restored", () => {
    const ids = visiblyLoadedIds(new Set(), ["b"]);
    expect(ids.has("b")).toBe(true);
  });

  it("unions the two without double counting", () => {
    const ids = visiblyLoadedIds(new Set(["a", "b"]), ["b", "c"]);
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the restored set it was given", () => {
    const restored = new Set(["a"]);
    visiblyLoadedIds(restored, ["b"]);
    expect([...restored]).toEqual(["a"]);
  });
});
