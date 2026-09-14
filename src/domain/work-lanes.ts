/**
 * Grouping and ordering for the unified workstream list.
 *
 * The sidebar shows one list of lanes, each holding its workstreams, plus a
 * "No lane" group for everything unfiled. Two rules drive everything here:
 *
 * 1. **"No lane" always exists**, even when empty, because it is the drop
 *    target for removing a workstream from a lane. Hiding it when empty would
 *    make removal impossible at precisely the moment every workstream has a
 *    lane.
 * 2. **Order is derived, never stored.** Manual ordering was removed, so both
 *    lanes and the workstreams inside them sort by name.
 */
import type { Workstream } from "./types";

/** A named container for related workstreams. */
export interface WorkLane {
  id: string;
  name: string;
}

/** One rendered folder: a lane, or the unfiled group. */
export interface LaneGroup {
  /** `null` for the "No lane" group. */
  lane: WorkLane | null;
  workstreams: Workstream[];
}

/** Stable id for the unfiled group, so callers can key and target it. */
export const NO_LANE_ID = "__no_lane__";

/** Label for the unfiled group. */
export const NO_LANE_LABEL = "No lane";

/**
 * Compares two display names.
 *
 * Case-insensitive with numeric collation, because the alternative is worse in
 * two specific ways users hit immediately: case-sensitive ordering files every
 * lowercase repo name (`media_components`) in a second alphabet after the
 * capitalised ones, and non-numeric collation sorts `PR 10` before `PR 9`.
 */
export function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Groups workstreams into their lanes, sorted for display.
 *
 * Lanes sort by name; the unfiled group always sorts last, because it is a
 * catch-all rather than a peer. Workstreams sort by name within each group.
 *
 * A lane with no workstreams still appears: the caller decides whether to show
 * it, and needs to know it exists to make that decision.
 */
export function groupByLane(
  workstreams: Workstream[],
  lanes: WorkLane[],
): LaneGroup[] {
  const byLane = new Map<string, Workstream[]>();
  const unfiled: Workstream[] = [];

  for (const workstream of workstreams) {
    const laneId = workstream.lane_id;
    // A lane_id pointing at a lane that no longer exists is treated as
    // unfiled rather than dropped, so a workstream can never become invisible
    // because of a stale reference.
    if (!laneId || !lanes.some((lane) => lane.id === laneId)) {
      unfiled.push(workstream);
      continue;
    }
    const existing = byLane.get(laneId);
    if (existing) existing.push(workstream);
    else byLane.set(laneId, [workstream]);
  }

  const groups: LaneGroup[] = lanes
    .slice()
    .sort((left, right) => compareNames(left.name, right.name))
    .map((lane) => ({
      lane,
      workstreams: sortWorkstreams(byLane.get(lane.id) ?? []),
    }));

  groups.push({ lane: null, workstreams: sortWorkstreams(unfiled) });
  return groups;
}

function sortWorkstreams(workstreams: Workstream[]): Workstream[] {
  return workstreams
    .slice()
    .sort((left, right) => compareNames(left.name, right.name));
}

/**
 * What the list is showing.
 *
 * Named for what each stop actually does, because the obvious labels would lie.
 * "Live / Live+Idle / All" reads as one scale, but live-vs-idle is a *runtime*
 * fact — are this workstream's tiles loaded right now? — while archived is a
 * persisted status. Restarting the app makes everything idle and archives
 * nothing, so presenting them as one axis mis-describes the thing.
 */
export type ListFilter = "loaded" | "not_archived" | "all";

export const LIST_FILTERS: readonly ListFilter[] = [
  "loaded",
  "not_archived",
  "all",
] as const;

export const LIST_FILTER_LABELS: Record<ListFilter, string> = {
  loaded: "Loaded",
  not_archived: "Not archived",
  all: "All",
};

const ARCHIVED_STATUSES: ReadonlySet<Workstream["status"]> = new Set([
  "archived",
  "archiving",
]);

/**
 * Statuses that stay visible under every filter.
 *
 * A workstream mid-creation, or one whose creation failed, is the case that
 * most needs the operator's attention — and `create_failed` in particular is
 * invisible in every other way. Filtering either away would hide the only
 * signal that something needs doing.
 */
const ALWAYS_VISIBLE: ReadonlySet<Workstream["status"]> = new Set([
  "creating",
  "create_failed",
]);

/** Whether a workstream passes the current filter. */
export function matchesFilter(
  workstream: Workstream,
  filter: ListFilter,
  loadedWsIds: ReadonlySet<string> | undefined | null,
): boolean {
  if (ALWAYS_VISIBLE.has(workstream.status)) return true;
  const archived = ARCHIVED_STATUSES.has(workstream.status);
  switch (filter) {
    case "all":
      return true;
    case "not_archived":
      return !archived;
    case "loaded":
      // Archived workstreams are never loaded, so this is narrower than
      // "not archived" rather than a different axis of it.
      return !archived && !!loadedWsIds?.has(workstream.id);
  }
}

/** Display label for a group, including the unfiled one. */
export function laneLabel(group: LaneGroup): string {
  return group.lane?.name ?? NO_LANE_LABEL;
}

/** Stable key for a group, including the unfiled one. */
export function laneKey(group: LaneGroup): string {
  return group.lane?.id ?? NO_LANE_ID;
}
