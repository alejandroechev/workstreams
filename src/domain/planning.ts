/**
 * ADO sprint and feature planning (ADR 039): the data the native side reads,
 * the planning draft, and what the Planning view computes from them.
 * Mirrors `src-tauri/src/ado_planning.rs`; the native summaries serve the CLI.
 */

export interface PlanningConnection {
  organization: string;
  project: string;
  team: string;
  team_id: string;
  area_path: string;
  backlog_iteration: string;
  order_field: string;
  effort_field: string;
}

export interface PlanningMe {
  id: string;
  display_name: string;
  unique_name: string;
}

export interface Iteration {
  name: string;
  path: string;
  start: string | null;
  finish: string | null;
  timeframe: string;
}

export interface PlanItem {
  id: number;
  rev: number;
  kind: string;
  title: string;
  state: string;
  assigned_to: string | null;
  assigned_to_me: boolean;
  iteration_path: string;
  story_points: number | null;
  order: number | null;
  target_date: string | null;
  parent_id: number | null;
  tasks_done: number;
  tasks_total: number;
  url: string;
  /** Child tasks of a story in the selected sprint, by state then backlog order; no Removed ones. */
  tasks?: PlanTask[];
}

export interface PlanTask {
  id: number;
  rev: number;
  title: string;
  state: string;
  assigned_to: string | null;
  assigned_to_me: boolean;
  order: number | null;
  url: string;
}

/** The states a task (or a story, through the resolve offer) can be set to, in display order. */
export const SETTABLE_STATES = ["New", "Active", "Blocked", "Resolved", "Closed"] as const;

export interface PlanningData {
  connection: PlanningConnection;
  me: PlanningMe;
  iterations: Iteration[];
  selected_sprint: string;
  previous_sprint: string | null;
  items: PlanItem[];
}

export type Change =
  | { kind: "move"; id: number; rev: number; to_iteration: string; assign_to_me: boolean }
  | { kind: "estimate"; id: number; rev: number; points: number | null }
  | { kind: "retitle"; id: number; rev: number; title: string }
  | { kind: "order"; id: number; rev: number; order: number }
  | { kind: "remove"; id: number; rev: number }
  /** A task's state, or a story's through the "resolve the story" offer. */
  | { kind: "set_state"; id: number; rev: number; state: string }
  /** Links one of your orphaned PRs to a work item (`id`). */
  | { kind: "link_pr"; id: number; rev: number; pr: PrRef }
  | { kind: "create_feature"; temp_id: number; title: string; target_date: string | null; description: string | null }
  | {
      kind: "create_story"; temp_id: number; parent: number; title: string; points: number | null; description: string | null;
      /** Planned into a sprint before it exists; otherwise its feature's iteration. */
      iteration?: string | null;
      /** Backlog order set before it exists. */
      order?: number | null;
    };

export interface PrRef {
  id: number;
  project_id: string;
  repo_id: string;
  title: string;
}

/** One of your PRs with no linked work item (the Orphaned PRs tab). */
export interface OrphanPr {
  id: number;
  title: string;
  project: string;
  project_id: string;
  repo: string;
  repo_id: string;
  /** "active", "draft" or "completed". */
  state: string;
  created: string;
  url: string;
}

export interface HiddenEntry {
  id: string;
  label: string;
}

export interface OrphanHidden {
  prs: HiddenEntry[];
  repos: HiddenEntry[];
}

export interface OrphanReport {
  days: number;
  /** Every orphan in the range, hidden ones included. */
  prs: OrphanPr[];
  hidden: OrphanHidden;
}

export const ORPHAN_RANGES = [7, 30, 90] as const;

export function isOrphanHidden(pr: OrphanPr, hidden: OrphanHidden): boolean {
  return hidden.prs.some((h) => h.id === String(pr.id)) || hidden.repos.some((h) => h.id === pr.repo_id);
}

/** The orphans the tab lists: hidden PRs and repos left out. */
export function visibleOrphans(report: OrphanReport): OrphanPr[] {
  return report.prs.filter((pr) => !isOrphanHidden(pr, report.hidden));
}

export interface LinkTarget {
  id: number;
  rev: number;
  title: string;
  task: boolean;
}

/**
 * What an orphaned PR can be linked to: the selected sprint's stories, each
 * followed by its tasks, then your features' other stories.
 */
export function linkTargets(data: PlanningData): LinkTarget[] {
  const stories = data.items.filter((i) => i.kind === "User Story" && i.state !== "Removed");
  const inSprint = stories.filter((s) => s.iteration_path === data.selected_sprint);
  const out: LinkTarget[] = [];
  for (const story of inSprint) {
    out.push({ id: story.id, rev: story.rev, title: story.title, task: false });
    for (const task of story.tasks ?? []) out.push({ id: task.id, rev: task.rev, title: task.title, task: true });
  }
  for (const story of stories) if (!inSprint.includes(story)) out.push({ id: story.id, rev: story.rev, title: story.title, task: false });
  return out;
}

export interface Conflict {
  id: number;
  title: string;
  field: string;
  ado_value: string;
}

export interface PublishResult {
  written: number[];
  conflicts: Conflict[];
  failures: Array<{ id: number; message: string }>;
  remaining: Change[];
}

export interface PlanningState {
  connection: PlanningConnection | null;
  selected_sprint: string | null;
  draft: Change[];
}

export const SPRINT_GOAL = 8;

const target = (c: Change) => ("id" in c ? c.id : c.temp_id);

/**
 * Adds a change to the draft, as the native side does: the last change of a
 * kind to an item wins; a change to an item not created yet edits its
 * creation; removing one drops it (and, for a feature, its new stories).
 */
export function addChange(draft: Change[], change: Change): Change[] {
  const id = target(change);
  if (id < 0 && change.kind !== "create_feature" && change.kind !== "create_story") {
    if (change.kind === "remove") {
      return draft.filter((c) => target(c) !== id && !(c.kind === "create_story" && c.parent === id));
    }
    return draft.map((c) => {
      if (target(c) !== id) return c;
      if (c.kind === "create_story" && change.kind === "estimate") return { ...c, points: change.points };
      if ((c.kind === "create_story" || c.kind === "create_feature") && change.kind === "retitle") return { ...c, title: change.title };
      if (c.kind === "create_story" && change.kind === "move") return { ...c, iteration: change.to_iteration };
      if (c.kind === "create_story" && change.kind === "order") return { ...c, order: change.order };
      return c;
    });
  }
  // Removing an item and setting its state both set its state: they replace each other.
  const slot = (kind: Change["kind"]) => (kind === "remove" || kind === "set_state" ? "state" : kind);
  // A PR has one pending link: linking it again moves the link.
  const index = change.kind === "link_pr"
    ? draft.findIndex((c) => c.kind === "link_pr" && c.pr.id === change.pr.id)
    : draft.findIndex((c) => slot(c.kind) === slot(change.kind) && target(c) === id);
  if (index < 0) return [...draft, change];
  return draft.map((c, i) => (i === index ? change : c));
}

/** The next temporary id for an item not created yet. */
export function nextTempId(draft: Change[]): number {
  return Math.min(0, ...draft.map(target)) - 1;
}

/**
 * The data as it will be once the draft is published: moved, re-estimated,
 * retitled, reordered and removed items, plus the items it creates.
 */
export function applyDraft(data: PlanningData, draft: Change[]): PlanItem[] {
  const items = data.items.map((item) => ({ ...item }));
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const change of draft) {
    if (change.kind === "create_feature") {
      const item: PlanItem = {
        id: change.temp_id, rev: 0, kind: "Feature", title: change.title, state: "New",
        assigned_to: data.me.display_name, assigned_to_me: true, iteration_path: data.connection.backlog_iteration,
        story_points: null, order: null, target_date: change.target_date, parent_id: null, tasks_done: 0, tasks_total: 0, url: "",
      };
      items.push(item);
      byId.set(item.id, item);
      continue;
    }
    if (change.kind === "create_story") {
      const parent = byId.get(change.parent);
      const item: PlanItem = {
        id: change.temp_id, rev: 0, kind: "User Story", title: change.title, state: "New",
        assigned_to: data.me.display_name, assigned_to_me: true,
        iteration_path: change.iteration ?? parent?.iteration_path ?? data.connection.backlog_iteration,
        story_points: change.points, order: change.order ?? null, target_date: null, parent_id: change.parent, tasks_done: 0, tasks_total: 0, url: "",
      };
      items.push(item);
      byId.set(item.id, item);
      continue;
    }
    if (change.kind === "link_pr") continue;
    if (change.kind === "set_state") {
      const item = byId.get(change.id);
      if (item) { item.state = change.state; continue; }
      for (const story of items) {
        const task = story.tasks?.find((t) => t.id === change.id);
        if (task) { story.tasks = sortTasks(story.tasks!.map((t) => (t === task ? { ...t, state: change.state } : t))); break; }
      }
      continue;
    }
    const item = byId.get(change.id);
    if (!item) continue;
    switch (change.kind) {
      case "move":
        item.iteration_path = change.to_iteration;
        if (change.assign_to_me) { item.assigned_to = data.me.display_name; item.assigned_to_me = true; }
        break;
      case "estimate": item.story_points = change.points; break;
      case "retitle": item.title = change.title; break;
      case "order": item.order = change.order; break;
      case "remove": item.state = "Removed"; break;
    }
  }
  return items;
}

const isDone = (state: string) => state === "Resolved" || state === "Closed";

const stateRank = (state: string) => {
  const index = (SETTABLE_STATES as readonly string[]).indexOf(state);
  return index < 0 ? SETTABLE_STATES.length : index;
};

/** Tasks by state (New, Active, Blocked, Resolved, Closed), then backlog order, as the native side lists them. */
export function sortTasks(tasks: PlanTask[]): PlanTask[] {
  return [...tasks].sort((a, b) =>
    stateRank(a.state) - stateRank(b.state) || (a.order ?? Infinity) - (b.order ?? Infinity) || a.id - b.id);
}

/** A story's task progress from its (possibly drafted) tasks. */
export function taskProgress(story: PlanItem): { done: number; total: number } {
  if (!story.tasks) return { done: story.tasks_done, total: story.tasks_total };
  return { done: story.tasks.filter((t) => isDone(t.state)).length, total: story.tasks.length };
}

/** Whether to offer resolving a story: it has tasks, all done, and isn't done itself. */
export function resolveOffer(story: PlanItem): boolean {
  const tasks = story.tasks ?? [];
  return tasks.length > 0 && tasks.every((t) => isDone(t.state)) && !isDone(story.state) && story.state !== "Removed";
}
const points = (i: PlanItem) => i.story_points ?? 0;
const sum = (items: PlanItem[]) => items.reduce((total, i) => total + points(i), 0);

export interface SprintSummary {
  committed: number;
  done: number;
  toGo: number;
  notEstimated: number;
  stories: PlanItem[];
}

/** Your user stories in the selected sprint, Removed excluded. */
export function sprintSummary(data: PlanningData, items: PlanItem[] = data.items): SprintSummary {
  const stories = items.filter((i) =>
    i.kind === "User Story" && i.assigned_to_me && i.state !== "Removed" && i.iteration_path === data.selected_sprint);
  const committed = sum(stories);
  const done = sum(stories.filter((s) => isDone(s.state)));
  return { committed, done, toGo: committed - done, notEstimated: stories.filter((s) => s.story_points === null).length, stories };
}

export interface FeatureSummary {
  feature: PlanItem;
  done: number;
  pending: number;
  myPending: number;
  notEstimated: number;
  sprintsLeft: number | null;
  atRisk: boolean;
  stories: PlanItem[];
}

const day = (t: string) => t.slice(0, 10);

/** Sprints from the selected one on that finish by the target date. */
export function sprintsLeft(data: PlanningData, targetDate: string): number {
  const from = Math.max(0, data.iterations.findIndex((i) => i.path === data.selected_sprint));
  return data.iterations.slice(from).filter((i) => i.finish !== null && day(i.finish) <= day(targetDate)).length;
}

/**
 * Your open features with all their stories (Removed left out). A feature is
 * at risk when your pending story points exceed the sprints left × 8.
 */
export function featureSummaries(data: PlanningData, items: PlanItem[] = data.items): FeatureSummary[] {
  return items
    .filter((i) => i.kind === "Feature" && i.state !== "Closed" && i.state !== "Removed")
    .map((feature) => {
      const stories = byOrder(items.filter((s) => s.kind === "User Story" && s.parent_id === feature.id && s.state !== "Removed"));
      const pendingStories = stories.filter((s) => !isDone(s.state));
      const myPending = sum(pendingStories.filter((s) => s.assigned_to_me));
      const left = feature.target_date ? sprintsLeft(data, feature.target_date) : null;
      return {
        feature,
        done: sum(stories.filter((s) => isDone(s.state))),
        pending: sum(pendingStories),
        myPending,
        notEstimated: stories.filter((s) => s.story_points === null).length,
        sprintsLeft: left,
        atRisk: left !== null && myPending > left * SPRINT_GOAL,
        stories,
      };
    });
}

/** Backlog order: lower first; unordered items last — existing ones by id, then new ones as added. */
export function byOrder(items: PlanItem[]): PlanItem[] {
  return [...items].sort((a, b) =>
    (a.order ?? Infinity) - (b.order ?? Infinity) || Number(a.id < 0) - Number(b.id < 0) || Math.abs(a.id) - Math.abs(b.id));
}

export type GaugeState = "under" | "on" | "over";

/** Feedback against the 8-point goal: green from 7 to 9, yellow below, orange above. Never a block. */
export function gauge(total: number): { state: GaugeState; text: string } {
  if (total > SPRINT_GOAL + 1) return { state: "over", text: `${round(total - SPRINT_GOAL)} over the goal` };
  if (total >= SPRINT_GOAL - 1) return { state: "on", text: "On target" };
  return { state: "under", text: `${round(SPRINT_GOAL - total)} to go` };
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function iterationByPath(data: PlanningData, path: string | null): Iteration | undefined {
  return data.iterations.find((i) => i.path === path);
}

/** Whole days until the sprint ends (0 once it has). */
export function daysLeft(iteration: Iteration | undefined, now: Date): number {
  if (!iteration?.finish) return 0;
  const end = Date.parse(`${day(iteration.finish)}T23:59:59Z`);
  return Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000));
}

/** The selected sprint has finished, and ADO has a current one to offer instead. */
export function endedSprintOffer(data: PlanningData, now: Date): Iteration | null {
  const selected = iterationByPath(data, data.selected_sprint);
  if (!selected?.finish || Date.parse(`${day(selected.finish)}T23:59:59Z`) >= now.getTime()) return null;
  return data.iterations.find((i) => i.timeframe === "current" && i.path !== selected.path) ?? null;
}

export interface CandidateGroup {
  key: string;
  label: string;
  carryOver: boolean;
  stories: PlanItem[];
}

const open = (i: PlanItem) => i.state === "New" || i.state === "Active";

/**
 * What can go into the selected sprint, by group: your unfinished stories
 * from the previous sprint (carried over), then your stories not in any
 * sprint, then unassigned stories in your features — each by feature, in
 * backlog order.
 */
export function candidates(data: PlanningData, items: PlanItem[]): CandidateGroup[] {
  const sprints = new Set(data.iterations.map((i) => i.path));
  const features = new Map(items.filter((i) => i.kind === "Feature").map((f) => [f.id, f]));
  const myFeatures = new Set([...features.values()].filter((f) => f.assigned_to_me).map((f) => f.id));
  const stories = items.filter((i) => i.kind === "User Story" && open(i) && i.iteration_path !== data.selected_sprint);
  const carried = stories.filter((s) => s.assigned_to_me && s.iteration_path === data.previous_sprint);
  const taken = new Set(carried.map((s) => s.id));
  const unplanned = stories.filter((s) => !taken.has(s.id) && s.assigned_to_me && !sprints.has(s.iteration_path));
  for (const s of unplanned) taken.add(s.id);
  const unassigned = stories.filter((s) =>
    !taken.has(s.id) && !s.assigned_to && s.parent_id !== null && myFeatures.has(s.parent_id) && !sprints.has(s.iteration_path));
  const groups: CandidateGroup[] = [];
  if (carried.length) groups.push({ key: "carry", label: "Carried over", carryOver: true, stories: byOrder(carried) });
  const byFeature = new Map<string, PlanItem[]>();
  for (const s of [...unplanned, ...unassigned]) {
    const key = s.parent_id !== null && features.has(s.parent_id) ? String(s.parent_id) : "none";
    byFeature.set(key, [...(byFeature.get(key) ?? []), s]);
  }
  const featureOrder = byOrder([...features.values()]).map((f) => String(f.id));
  for (const key of [...featureOrder, "none"]) {
    const list = byFeature.get(key);
    if (!list) continue;
    groups.push({ key, label: key === "none" ? "No feature" : features.get(Number(key))!.title, carryOver: false, stories: byOrder(list) });
  }
  return groups;
}

/** Where a story dragged out of the selected sprint goes: its feature's iteration, or the team backlog. */
export function outOfSprintIteration(data: PlanningData, items: PlanItem[], story: PlanItem): string {
  const sprints = new Set(data.iterations.map((i) => i.path));
  const parent = items.find((i) => i.id === story.parent_id);
  if (parent && !sprints.has(parent.iteration_path)) return parent.iteration_path;
  return data.connection.backlog_iteration;
}

/** The backlog order that puts an item between two neighbours (either may be missing). */
export function orderBetween(before: number | null | undefined, after: number | null | undefined): number {
  if (before == null && after == null) return 1000;
  if (before == null) return (after as number) - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

/** A short "N not published" label for the draft bar. */
export function draftLabel(draft: Change[]): string {
  return `${draft.length} change${draft.length === 1 ? "" : "s"} not published`;
}

/** One line per draft change, for the review list. */
export function describeChange(change: Change, data: PlanningData | null, items: PlanItem[]): string {
  const title = (id: number) => items.find((i) => i.id === id)?.title ?? `#${id}`;
  const sprint = (path: string) => data?.iterations.find((i) => i.path === path)?.name ?? path.split("\\").pop() ?? path;
  switch (change.kind) {
    case "move": return `Move “${title(change.id)}” to ${sprint(change.to_iteration)}${change.assign_to_me ? " (and assign to you)" : ""}`;
    case "estimate": return `Estimate “${title(change.id)}”: ${change.points ?? "none"} SP`;
    case "retitle": return `Rename #${change.id} to “${change.title}”`;
    case "order": return `Reorder “${title(change.id)}”`;
    case "remove": return `Remove “${title(change.id)}” (state Removed)`;
    case "link_pr": {
      const task = items.flatMap((i) => i.tasks ?? []).find((t) => t.id === change.id);
      return `Link PR “${change.pr.title}” to “${items.find((i) => i.id === change.id)?.title ?? task?.title ?? `#${change.id}`}”`;
    }
    case "set_state": {
      if (items.some((i) => i.id === change.id)) return `Set “${title(change.id)}” to ${change.state}`;
      const task = items.flatMap((i) => i.tasks ?? []).find((t) => t.id === change.id);
      return `Set task “${task?.title ?? `#${change.id}`}” to ${change.state}`;
    }
    case "create_feature": return `New feature “${change.title}”${change.target_date ? `, target ${change.target_date}` : ""}`;
    case "create_story": return `New story “${change.title}” (${change.points ?? "?"} SP) in ${title(change.parent)}`;
  }
}

/** Reads a team sprint, backlog or board link, as the native side does (for the in-memory backend). */
export function parseTeamLink(text: string): { organization: string; project: string; team: string } | null {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username) return null;
  const path = url.pathname.replace(/^\/+|\/+$/g, "").split("/").map((s) => { try { return decodeURIComponent(s); } catch { return ""; } });
  const host = url.hostname.toLowerCase();
  let organization: string;
  let rest: string[];
  if (host === "dev.azure.com" && path.length >= 2) { organization = path[0]; rest = path.slice(1); }
  else if (host.endsWith(".visualstudio.com") && !host.slice(0, -".visualstudio.com".length).includes(".")) {
    organization = host.slice(0, -".visualstudio.com".length); rest = path;
  } else return null;
  const project = rest[0] ?? "";
  let team: string | undefined;
  if (rest[1] === "_sprints" || rest[1] === "_backlogs") team = rest[3];
  else if (rest[1] === "_boards" && rest[2] === "board") team = rest[3] === "t" ? rest[4] : rest[3];
  const valid = (s: string | undefined): s is string => !!s && s !== "." && s !== ".." && !/[/\\]/.test(s);
  return valid(organization) && valid(project) && valid(team) ? { organization, project, team } : null;
}
