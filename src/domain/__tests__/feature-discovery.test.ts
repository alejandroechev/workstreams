import { describe, it, expect } from "vitest";
import {
  reconcileFeatures,
  applyFilter,
  sortByLastTouchedDesc,
  todosForPlan,
  type FeatureFolder,
  type FeaturePlanRow,
} from "../feature-discovery";

function folder(name: string, overrides: Partial<FeatureFolder> = {}): FeatureFolder {
  return {
    name,
    hasGrillMe: true,
    hasPlan: true,
    grillMePath: `C:/fake/${name}/grill-me.md`,
    planPath: `C:/fake/${name}/plan.md`,
    filesLastMtime: "2026-06-12T10:00:00.000Z",
    ...overrides,
  };
}

function plan(featureName: string, overrides: Partial<FeaturePlanRow> = {}): FeaturePlanRow {
  return {
    id: `${featureName}-aaa111`,
    feature_name: featureName,
    title: `${featureName} title`,
    status: "active",
    created_at: "2026-06-12T09:00:00.000Z",
    todosLastUpdatedAt: "2026-06-12T11:00:00.000Z",
    todosTotal: 5,
    todosDone: 2,
    todosInProgress: 1,
    todosBlocked: 0,
    ...overrides,
  };
}

describe("reconcileFeatures", () => {
  it("returns empty array for empty input", () => {
    expect(reconcileFeatures({ folders: [], plans: [] })).toEqual([]);
  });

  it("marks folder-without-plan as drafting with zero todo counts", () => {
    const out = reconcileFeatures({
      folders: [folder("alpha", { hasPlan: false, planPath: null })],
      plans: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].derivedStatus).toBe("drafting");
    expect(out[0].planId).toBeNull();
    expect(out[0].todosTotal).toBe(0);
  });

  it("joins folder with plan row when feature_name matches", () => {
    const out = reconcileFeatures({
      folders: [folder("alpha")],
      plans: [plan("alpha")],
    });
    expect(out[0].derivedStatus).toBe("active");
    expect(out[0].planId).toBe("alpha-aaa111");
    expect(out[0].todosTotal).toBe(5);
  });

  it("mirrors plan status (completed / archived) when present", () => {
    const out = reconcileFeatures({
      folders: [folder("a"), folder("b")],
      plans: [plan("a", { status: "completed" }), plan("b", { status: "archived" })],
    });
    expect(out.find((f) => f.name === "a")?.derivedStatus).toBe("completed");
    expect(out.find((f) => f.name === "b")?.derivedStatus).toBe("archived");
  });

  it("matches feature names case-sensitively (different cases stay separate)", () => {
    const out = reconcileFeatures({
      folders: [folder("user-auth")],
      plans: [plan("User-Auth")],
    });
    // Folder stays drafting (no matching plan); plan becomes orphan.
    expect(out).toHaveLength(2);
    const folderRow = out.find((f) => f.name === "user-auth")!;
    expect(folderRow.derivedStatus).toBe("drafting");
    const orphanRow = out.find((f) => f.name === "User-Auth")!;
    expect(orphanRow.derivedStatus).toBe("orphan");
  });

  it("marks plan-without-folder as orphan", () => {
    const out = reconcileFeatures({
      folders: [],
      plans: [plan("ghost")],
    });
    expect(out).toHaveLength(1);
    expect(out[0].derivedStatus).toBe("orphan");
    expect(out[0].hasGrillMe).toBe(false);
    expect(out[0].hasPlan).toBe(false);
    expect(out[0].todosTotal).toBe(5);
  });

  it("multiple plan rows for same feature → latest created_at wins", () => {
    const out = reconcileFeatures({
      folders: [folder("alpha")],
      plans: [
        plan("alpha", { id: "alpha-old", created_at: "2026-06-01T00:00:00.000Z", title: "old" }),
        plan("alpha", { id: "alpha-new", created_at: "2026-06-12T00:00:00.000Z", title: "new" }),
        plan("alpha", { id: "alpha-mid", created_at: "2026-06-05T00:00:00.000Z", title: "mid" }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].planId).toBe("alpha-new");
    expect(out[0].planTitle).toBe("new");
  });

  it("orders folder-driven rows alphabetically, then orphans alphabetically", () => {
    const out = reconcileFeatures({
      folders: [folder("zebra"), folder("apple")],
      plans: [plan("zebra"), plan("ghost"), plan("apple")],
    });
    expect(out.map((f) => f.name)).toEqual(["apple", "zebra", "ghost"]);
  });

  it("computeLastTouched picks the most recent across folder mtime + todos + plan created_at", () => {
    const out = reconcileFeatures({
      folders: [folder("alpha", { filesLastMtime: "2026-01-01T00:00:00.000Z" })],
      plans: [plan("alpha", { todosLastUpdatedAt: "2026-12-01T00:00:00.000Z", created_at: "2026-06-01T00:00:00.000Z" })],
    });
    expect(out[0].lastTouchedAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("computeLastTouched falls back through null candidates", () => {
    const out = reconcileFeatures({
      folders: [folder("alpha", { hasGrillMe: false, hasPlan: false, grillMePath: null, planPath: null, filesLastMtime: null })],
      plans: [plan("alpha", { todosLastUpdatedAt: null, created_at: "2026-06-12T09:00:00.000Z" })],
    });
    expect(out[0].lastTouchedAt).toBe("2026-06-12T09:00:00.000Z");
  });

  it("lastTouchedAt is empty string when nothing is available (drafting folder with null mtime)", () => {
    const out = reconcileFeatures({
      folders: [folder("alpha", { hasPlan: false, planPath: null, filesLastMtime: null })],
      plans: [],
    });
    expect(out[0].lastTouchedAt).toBe("");
  });
});

describe("applyFilter", () => {
  function feats() {
    return reconcileFeatures({
      folders: [folder("draft", { hasPlan: false, planPath: null }), folder("act"), folder("done")],
      plans: [plan("act"), plan("done", { status: "completed" })],
    });
  }
  it("'all' returns everything", () => {
    expect(applyFilter(feats(), "all").map((f) => f.name).sort()).toEqual(["act", "done", "draft"]);
  });
  it("'active' shows drafting + active + orphan, hides completed/archived", () => {
    expect(applyFilter(feats(), "active").map((f) => f.name).sort()).toEqual(["act", "draft"]);
  });
  it("'completed' shows completed + archived only", () => {
    expect(applyFilter(feats(), "completed").map((f) => f.name)).toEqual(["done"]);
  });
  it("'active' includes orphans", () => {
    const features = reconcileFeatures({ folders: [], plans: [plan("ghost")] });
    expect(applyFilter(features, "active").map((f) => f.name)).toEqual(["ghost"]);
  });
});

describe("sortByLastTouchedDesc", () => {
  it("sorts by lastTouchedAt descending", () => {
    const out = reconcileFeatures({
      folders: [
        folder("old", { filesLastMtime: "2026-01-01T00:00:00.000Z" }),
        folder("new", { filesLastMtime: "2026-12-01T00:00:00.000Z" }),
        folder("mid", { filesLastMtime: "2026-06-01T00:00:00.000Z" }),
      ],
      plans: [],
    });
    expect(sortByLastTouchedDesc(out).map((f) => f.name)).toEqual(["new", "mid", "old"]);
  });
  it("empty lastTouchedAt sinks to bottom", () => {
    const out = reconcileFeatures({
      folders: [
        folder("a", { filesLastMtime: "2026-06-01T00:00:00.000Z" }),
        folder("empty", { hasPlan: false, planPath: null, filesLastMtime: null }),
      ],
      plans: [],
    });
    expect(sortByLastTouchedDesc(out).map((f) => f.name)).toEqual(["a", "empty"]);
  });
  it("equal lastTouchedAt falls back to name asc", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const out = reconcileFeatures({
      folders: [folder("z", { filesLastMtime: ts }), folder("a", { filesLastMtime: ts })],
      plans: [],
    });
    expect(sortByLastTouchedDesc(out).map((f) => f.name)).toEqual(["a", "z"]);
  });
});

describe("todosForPlan", () => {
  const todos = [
    { id: "t1", title: "x", description: null, status: "pending", plan_id: "p1" },
    { id: "t2", title: "y", description: null, status: "done", plan_id: "p1" },
    { id: "t3", title: "z", description: null, status: "pending", plan_id: "p2" },
    { id: "t4", title: "no plan", description: null, status: "pending", plan_id: null },
  ];
  it("returns matching todos for plan id", () => {
    expect(todosForPlan(todos, "p1").map((t) => t.id)).toEqual(["t1", "t2"]);
  });
  it("returns empty list when planId is null", () => {
    expect(todosForPlan(todos, null)).toEqual([]);
  });
  it("returns empty list when no todo matches", () => {
    expect(todosForPlan(todos, "missing")).toEqual([]);
  });
});
