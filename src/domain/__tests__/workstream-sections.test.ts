import { describe, it, expect } from "vitest";
import { bucketWorkstreams, relativeAge, isSectionCollapsed } from "../workstream-sections";
import type { Workstream } from "../types";

function ws(id: string, status: Workstream["status"]): Workstream {
  return {
    id,
    name: id,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status,
    project_id: null,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

describe("bucketWorkstreams", () => {
  it("splits active workstreams by whether they are loaded", () => {
    const list = [ws("a", "active"), ws("b", "active"), ws("c", "active")];
    const { live, idle } = bucketWorkstreams(list, new Set(["a", "c"]));

    expect(live.map((w) => w.id)).toEqual(["a", "c"]);
    expect(idle.map((w) => w.id)).toEqual(["b"]);
  });

  it("treats archiving as archived so a cleanup in flight leaves the working list", () => {
    const { archived, idle } = bucketWorkstreams(
      [ws("a", "archived"), ws("b", "archiving")],
      new Set(),
    );

    expect(archived.map((w) => w.id)).toEqual(["a", "b"]);
    expect(idle).toEqual([]);
  });

  it("keeps transient provisioning states in the working list, not archived", () => {
    // A workstream being created is very much live work, and a failed create
    // must stay visible so it can be retried or discarded.
    const { live, idle, archived } = bucketWorkstreams(
      [ws("a", "creating"), ws("b", "create_failed")],
      new Set(["a"]),
    );

    expect(live.map((w) => w.id)).toEqual(["a"]);
    expect(idle.map((w) => w.id)).toEqual(["b"]);
    expect(archived).toEqual([]);
  });

  it("treats every non-archived workstream as idle when nothing is loaded", () => {
    const list = [ws("a", "active"), ws("b", "working"), ws("c", "blocked")];
    const { live, idle } = bucketWorkstreams(list, new Set());

    expect(live).toEqual([]);
    expect(idle).toHaveLength(3);
  });

  it("treats an undefined loaded set as 'nothing known to be loaded'", () => {
    // The prop is optional; callers that never pass it must not lose rows.
    const { live, idle } = bucketWorkstreams([ws("a", "active")], undefined);

    expect(live).toEqual([]);
    expect(idle.map((w) => w.id)).toEqual(["a"]);
  });

  it("ignores loaded ids that refer to archived or unknown workstreams", () => {
    const { live, archived } = bucketWorkstreams(
      [ws("a", "archived")],
      new Set(["a", "ghost"]),
    );

    expect(live).toEqual([]);
    expect(archived.map((w) => w.id)).toEqual(["a"]);
  });

  it("preserves the incoming order inside each bucket so drag order survives", () => {
    const list = [ws("c", "active"), ws("a", "active"), ws("b", "active")];
    const { idle } = bucketWorkstreams(list, new Set());

    expect(idle.map((w) => w.id)).toEqual(["c", "a", "b"]);
  });

  it("returns empty buckets for an empty list", () => {
    expect(bucketWorkstreams([], new Set())).toEqual({ live: [], idle: [], archived: [] });
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-08-19T12:00:00Z");

  it("reports today for something touched in the last day", () => {
    expect(relativeAge("2026-08-19T09:00:00Z", now)).toBe("today");
  });

  it("reports days, weeks, then months as work goes stale", () => {
    expect(relativeAge("2026-08-18T09:00:00Z", now)).toBe("1d");
    expect(relativeAge("2026-08-15T12:00:00Z", now)).toBe("4d");
    expect(relativeAge("2026-08-05T12:00:00Z", now)).toBe("2w");
    expect(relativeAge("2026-05-19T12:00:00Z", now)).toBe("3mo");
  });

  it("never renders a negative age for a clock skewed into the future", () => {
    expect(relativeAge("2026-09-01T00:00:00Z", now)).toBe("today");
  });

  it("returns an empty string for a missing or unparseable timestamp", () => {
    expect(relativeAge(null, now)).toBe("");
    expect(relativeAge("not-a-date", now)).toBe("");
  });
});

describe("isSectionCollapsed", () => {
  it("keeps Live expanded", () => {
    expect(isSectionCollapsed("live", {}, 3)).toBe(false);
  });

  it("collapses Idle when there is live work to focus on", () => {
    expect(isSectionCollapsed("idle", {}, 3)).toBe(true);
  });

  it("EXPANDS Idle when nothing is live, so the sidebar is never empty", () => {
    // On a cold start nothing is loaded, so every workstream is idle.
    // Defaulting Idle to collapsed would hide the entire list.
    expect(isSectionCollapsed("idle", {}, 0)).toBe(false);
  });

  it("always honours an explicit user choice over the default", () => {
    expect(isSectionCollapsed("idle", { idle: false }, 3)).toBe(false);
    expect(isSectionCollapsed("idle", { idle: true }, 0)).toBe(true);
    expect(isSectionCollapsed("live", { live: true }, 3)).toBe(true);
  });
});
