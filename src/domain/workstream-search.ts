/**
 * Free-text filtering of the workstream list.
 *
 * Separate from `work-lanes.ts` because it answers a different question. The
 * three stops there (Loaded / Not archived / All) are about a workstream's
 * *state*; this is about its *identity*. They compose — text narrows within
 * the current stop — but neither is a special case of the other.
 */
import type { Workstream } from "./types";

/**
 * Whether the user is actually searching.
 *
 * Whitespace is not a search. Getting this wrong would collapse every empty
 * lane and fire the "no matches" hint the moment someone hit the space bar.
 */
export function isSearching(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * Statuses a text search must never hide.
 *
 * `create_failed` is the only one. ADR 027 keeps it visible under every stop
 * because it has no other signal anywhere in the UI — if the list hides it, the
 * workstream is simply gone and the failure is never dealt with. A text search
 * is still a filter, so the same argument applies unchanged.
 *
 * `creating` is deliberately *not* here, unlike in `matchesFilter`. It resolves
 * on its own within seconds and needs nobody's attention, so during a search it
 * is just a row that does not match what you typed.
 */
const NEVER_HIDDEN: ReadonlySet<Workstream["status"]> = new Set(["create_failed"]);

/** Looks up a workstream's repo name, or `undefined` for a standalone one. */
export type RepoNameLookup = (projectId: string | null) => string | undefined;

/**
 * Whether a workstream matches the text query.
 *
 * Matches the workstream name **and** its repo name: "show me everything in
 * waimea" is a real query, and the repo is not part of the workstream's own
 * name. Branch is deliberately excluded — it is usually a slug of the name
 * already, so it adds matches without adding reach.
 */
export function matchesText(
  workstream: Workstream,
  query: string,
  repoName: RepoNameLookup | undefined,
): boolean {
  if (!isSearching(query)) return true;
  if (NEVER_HIDDEN.has(workstream.status)) return true;

  const needle = query.trim().toLowerCase();
  if (workstream.name.toLowerCase().includes(needle)) return true;

  const repo = repoName?.(workstream.project_id);
  return !!repo && repo.toLowerCase().includes(needle);
}

/**
 * Whether a lane's header should render given how many rows survived the
 * filters.
 *
 * `groupByLane` emits every lane unconditionally, because a lane is a drop
 * target and hiding an empty one makes a lane you just created impossible to
 * drag into (ADR 027). That reasoning does not survive a text search: you are
 * reading a result set, not dragging, and eight empty lane headers wrapped
 * around a single hit is unreadable.
 *
 * So the rule is conditional rather than a reversal — empty lanes disappear
 * *while searching* and come straight back when the box is cleared.
 */
export function laneVisibleWhileSearching(
  matchCount: number,
  searching: boolean,
): boolean {
  return matchCount > 0 || !searching;
}

/**
 * How many workstreams match the text but are excluded by the current stop.
 *
 * Exists for one failure: you are on **Loaded**, you type the name of
 * something you archived last week, and the list goes empty. Nothing is broken,
 * but it looks broken — and the fix, change the stop, is the one thing an empty
 * list cannot tell you. This is the number that turns "no results" into "no
 * results *here*".
 *
 * Returns 0 when not searching, because then an empty list is fully explained
 * by the stop the user just chose and a hint would fire every time they picked
 * Loaded.
 */
export function matchesElsewhere(
  all: readonly Workstream[],
  visible: readonly Workstream[],
  query: string,
  repoName: RepoNameLookup | undefined,
): number {
  if (!isSearching(query)) return 0;
  const onScreen = new Set(visible.map((workstream) => workstream.id));
  return all.filter(
    (workstream) =>
      !onScreen.has(workstream.id) && matchesText(workstream, query, repoName),
  ).length;
}
