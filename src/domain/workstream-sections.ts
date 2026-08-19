/**
 * Sidebar status bucketing.
 *
 * The persisted `WorkstreamStatus` only distinguishes archived from everything
 * else. What the user actually thinks of as three states is two axes:
 *
 *   live     = not archived, AND its tiles/processes are loaded
 *   idle     = not archived, but nothing is running ("closed")
 *   archived = archived, or mid-`archiving` cleanup
 *
 * "Closed" was never a status — it is the absence of a runtime session, which
 * is why closed workstreams used to sit in the main list looking identical to
 * live ones. Splitting on `loadedWsIds` is what makes them separable.
 */
import type { Workstream } from "./types";

export interface WorkstreamBuckets {
  live: Workstream[];
  idle: Workstream[];
  archived: Workstream[];
}

/** `archiving` is logically archived — only its worktree cleanup is pending. */
const ARCHIVED_STATUSES: ReadonlySet<Workstream["status"]> = new Set([
  "archived",
  "archiving",
]);

/**
 * Split workstreams into the three sidebar sections, preserving the caller's
 * order within each bucket so drag-and-drop ordering survives the split.
 */
export function bucketWorkstreams(
  workstreams: Workstream[],
  loadedWsIds: Set<string> | undefined | null,
): WorkstreamBuckets {
  const live: Workstream[] = [];
  const idle: Workstream[] = [];
  const archived: Workstream[] = [];

  for (const ws of workstreams) {
    if (ARCHIVED_STATUSES.has(ws.status)) {
      archived.push(ws);
    } else if (loadedWsIds?.has(ws.id)) {
      live.push(ws);
    } else {
      idle.push(ws);
    }
  }

  return { live, idle, archived };
}

const DAY_MS = 86_400_000;

/**
 * Compact staleness label (`today`, `4d`, `2w`, `3mo`) for an idle row.
 *
 * Age is what makes the idle pile triageable rather than merely tidy: without
 * it, ten stopped workstreams look equally current. Returns "" when there is
 * nothing sensible to show, so callers can omit the element entirely.
 */
export function relativeAge(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const days = Math.floor((now.getTime() - then) / DAY_MS);
  if (days <= 0) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/**
 * Whether a sidebar section should render collapsed.
 *
 * `overrides` holds explicit user toggles and always wins. The default matters
 * more than it looks: on a cold start nothing is loaded, so *every* workstream
 * is idle — defaulting Idle to collapsed would leave the sidebar looking empty.
 * So Idle only auto-collapses when there is live work to focus on instead.
 */
export function isSectionCollapsed(
  key: "live" | "idle",
  overrides: Record<string, boolean | undefined>,
  liveCount: number,
): boolean {
  const explicit = overrides[key];
  if (typeof explicit === "boolean") return explicit;
  return key === "idle" && liveCount > 0;
}
