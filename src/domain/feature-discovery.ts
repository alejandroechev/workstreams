import type {
  FeatureDerivedStatus,
  FeatureSummary,
  SessionTodo,
} from "../backend/types";

/**
 * Minimal "row from disk" shape the discovery logic needs. The Rust
 * backend produces these by walking `<session>/files/features/*`.
 */
export interface FeatureFolder {
  name: string;
  hasGrillMe: boolean;
  hasPlan: boolean;
  grillMePath: string | null;
  planPath: string | null;
  /** Most recent mtime across grill-me.md + plan.md, ISO-8601. */
  filesLastMtime: string | null;
}

/**
 * Minimal "row from SQL" shape the discovery logic needs. The Rust
 * backend reads these from `plans` joined with `todos` status counts.
 */
export interface FeaturePlanRow {
  id: string;
  feature_name: string;
  title: string;
  status: "active" | "completed" | "archived";
  created_at: string;
  /** Most recent updated_at across todos for this plan_id, ISO-8601. */
  todosLastUpdatedAt: string | null;
  todosTotal: number;
  todosDone: number;
  todosInProgress: number;
  todosBlocked: number;
}

interface ReconcileInput {
  folders: FeatureFolder[];
  plans: FeaturePlanRow[];
}

/**
 * Pure helper: join folder list with plan rows by **case-sensitive**
 * feature name, derive a `FeatureSummary` per feature, and compute
 * the union (drafting / active / completed / archived / orphan).
 *
 * Rules:
 *  - Folder + plan row → mirrors the plan's status.
 *  - Folder only (no plan row) → `drafting`.
 *  - Plan row only (no folder) → `orphan`.
 *  - Multiple plan rows for the same feature_name → latest
 *    `created_at` wins (MVP). Older ones are dropped from the
 *    summary; a future "history" sub-tab will surface them.
 *
 * Order in the output is **folder-first** (sorted alphabetically by
 * name), followed by orphans (also alphabetical). The frontend
 * re-sorts as the user requests; this stable shape just makes tests
 * easier to write.
 */
export function reconcileFeatures(input: ReconcileInput): FeatureSummary[] {
  // Latest-wins map keyed by feature_name.
  const latestPlan = new Map<string, FeaturePlanRow>();
  for (const p of input.plans) {
    const existing = latestPlan.get(p.feature_name);
    if (!existing || p.created_at.localeCompare(existing.created_at) > 0) {
      latestPlan.set(p.feature_name, p);
    }
  }

  const folderNames = new Set(input.folders.map((f) => f.name));

  const out: FeatureSummary[] = [];

  // 1) Folder-driven rows (including drafting + folder+plan combos).
  const sortedFolders = [...input.folders].sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of sortedFolders) {
    const plan = latestPlan.get(folder.name) ?? null;
    out.push(makeSummary(folder, plan));
  }

  // 2) Orphan plans (plan row exists, folder does not).
  const orphans = [...latestPlan.values()]
    .filter((p) => !folderNames.has(p.feature_name))
    .sort((a, b) => a.feature_name.localeCompare(b.feature_name));
  for (const p of orphans) {
    out.push(makeOrphanSummary(p));
  }

  return out;
}

function makeSummary(folder: FeatureFolder, plan: FeaturePlanRow | null): FeatureSummary {
  const derivedStatus: FeatureDerivedStatus = plan ? plan.status : "drafting";
  const lastTouchedAt = computeLastTouched(folder, plan);
  return {
    name: folder.name,
    hasGrillMe: folder.hasGrillMe,
    hasPlan: folder.hasPlan,
    grillMePath: folder.grillMePath,
    planPath: folder.planPath,
    planId: plan?.id ?? null,
    planTitle: plan?.title ?? null,
    planStatus: plan?.status ?? null,
    planCreatedAt: plan?.created_at ?? null,
    derivedStatus,
    todosTotal: plan?.todosTotal ?? 0,
    todosDone: plan?.todosDone ?? 0,
    todosInProgress: plan?.todosInProgress ?? 0,
    todosBlocked: plan?.todosBlocked ?? 0,
    lastTouchedAt,
  };
}

function makeOrphanSummary(plan: FeaturePlanRow): FeatureSummary {
  return {
    name: plan.feature_name,
    hasGrillMe: false,
    hasPlan: false,
    grillMePath: null,
    planPath: null,
    planId: plan.id,
    planTitle: plan.title,
    planStatus: plan.status,
    planCreatedAt: plan.created_at,
    derivedStatus: "orphan",
    todosTotal: plan.todosTotal,
    todosDone: plan.todosDone,
    todosInProgress: plan.todosInProgress,
    todosBlocked: plan.todosBlocked,
    lastTouchedAt: plan.todosLastUpdatedAt ?? plan.created_at,
  };
}

function computeLastTouched(folder: FeatureFolder, plan: FeaturePlanRow | null): string {
  const candidates = [
    folder.filesLastMtime,
    plan?.todosLastUpdatedAt ?? null,
    plan?.created_at ?? null,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (candidates.length === 0) return "";
  return candidates.reduce((a, b) => (a.localeCompare(b) >= 0 ? a : b));
}

/**
 * Filter chip options for the sidebar. "active" includes drafting +
 * orphan because both are "things you might want to look at"; only
 * truly completed/archived are hidden.
 */
export type FeatureFilter = "active" | "completed" | "all";

export function applyFilter(features: FeatureSummary[], filter: FeatureFilter): FeatureSummary[] {
  if (filter === "all") return features;
  if (filter === "completed") {
    return features.filter((f) => f.derivedStatus === "completed" || f.derivedStatus === "archived");
  }
  // active
  return features.filter(
    (f) =>
      f.derivedStatus === "drafting" ||
      f.derivedStatus === "active" ||
      f.derivedStatus === "orphan",
  );
}

/**
 * Sort by `lastTouchedAt` descending. Features with no mtime ("")
 * sink to the bottom.
 */
export function sortByLastTouchedDesc(features: FeatureSummary[]): FeatureSummary[] {
  return [...features].sort((a, b) => {
    if (a.lastTouchedAt === b.lastTouchedAt) return a.name.localeCompare(b.name);
    if (a.lastTouchedAt === "") return 1;
    if (b.lastTouchedAt === "") return -1;
    return b.lastTouchedAt.localeCompare(a.lastTouchedAt);
  });
}

/**
 * Subset of todos for the given plan_id. Empty list when planId is
 * null. Pure filter — frontend uses this when slicing the global
 * todos list for a selected feature.
 */
export function todosForPlan(allTodos: SessionTodo[], planId: string | null): SessionTodo[] {
  if (!planId) return [];
  return allTodos.filter((t) => t.plan_id === planId);
}
