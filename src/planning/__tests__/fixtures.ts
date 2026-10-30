/**
 * In-memory ADO teams for Planning's tests, one per acceptance scenario
 * (files/features/ado-planning/acceptance.md). Shared by unit and E2E tests.
 */
import type { Iteration, PlanItem } from "../../domain/planning";
import type { MemoryPlanningPr } from "../../backend/memory-backend";

export const TEAM_LINK = "https://skype.visualstudio.com/OneWork/_sprints/taskboard/Waimea%20Bay/OneWork/CY26/H2/Q4/Oct/S22%20(Nov%208)";
export const BACKLOG_LINK = "https://dev.azure.com/skype/OneWork/_backlogs/backlog/Waimea%20Bay/Features";

export const ITERATIONS: Iteration[] = [
  { name: "S21 (Oct 25)", path: "OneWork\\S21", start: "2026-10-12T00:00:00Z", finish: "2026-10-25T00:00:00Z", timeframe: "past" },
  { name: "S22 (Nov 8)", path: "OneWork\\S22", start: "2026-10-26T00:00:00Z", finish: "2026-11-08T00:00:00Z", timeframe: "current" },
  { name: "S23 (Nov 22)", path: "OneWork\\S23", start: "2026-11-09T00:00:00Z", finish: "2026-11-22T00:00:00Z", timeframe: "future" },
  { name: "S24 (Dec 6)", path: "OneWork\\S24", start: "2026-11-23T00:00:00Z", finish: "2026-12-06T00:00:00Z", timeframe: "future" },
];

export function item(id: number, over: Partial<PlanItem> = {}): PlanItem {
  return {
    id, rev: 1, kind: "User Story", title: `Story ${id}`, state: "New", assigned_to: "Me", assigned_to_me: true,
    iteration_path: "OneWork\\Q4", story_points: 1, order: null, target_date: null, parent_id: null,
    tasks_done: 0, tasks_total: 0, url: `https://dev.azure.com/skype/OneWork/_workitems/edit/${id}`,
    ...over,
  };
}

const feature = (id: number, title: string, over: Partial<PlanItem> = {}) =>
  item(id, { kind: "Feature", title, state: "Active", story_points: null, ...over });
const erwin = { assigned_to: "Erwin Alvarez", assigned_to_me: false };

/** AT-3: your four stories in S22, plus someone else's story and a bug. */
export function sprintTeam(): PlanItem[] {
  return [
    feature(200, "Audio Transcoding", { target_date: "2026-12-31T00:00:00Z" }),
    item(1, { title: "AMS List Streams", state: "Closed", story_points: 1, iteration_path: "OneWork\\S22", parent_id: 200 }),
    item(2, { title: "Auth", story_points: 3, iteration_path: "OneWork\\S22", parent_id: 200, tasks_total: 3 }),
    item(3, { title: "AMS Application State", state: "Active", story_points: 3, iteration_path: "OneWork\\S22", parent_id: 200, tasks_done: 2, tasks_total: 4 }),
    item(4, { title: "Not estimated yet", story_points: null, iteration_path: "OneWork\\S22", parent_id: 200 }),
    item(5, { title: "Erwin's story", ...erwin, story_points: 8, iteration_path: "OneWork\\S22" }),
    item(6, { kind: "Bug", title: "A bug", iteration_path: "OneWork\\S22" }),
  ];
}

/** AT-4: one feature two sprints from its target, with every kind of child. */
export function featureTeam(): PlanItem[] {
  return [
    feature(100, "Media_Store Read support", { target_date: "2026-11-22T00:00:00Z", order: 1 }),
    feature(300, "Audio Transcoding", { target_date: "2026-12-31T00:00:00Z", order: 2 }),
    feature(400, "Old feature", { state: "Closed" }),
    item(11, { title: "Closed one", state: "Closed", story_points: 3, parent_id: 100 }),
    item(12, { title: "Resolved one", state: "Resolved", story_points: 2, parent_id: 100 }),
    item(13, { title: "Five", story_points: 5, parent_id: 100 }),
    item(14, { title: "Eight", story_points: 8, parent_id: 100 }),
    item(15, { title: "Unestimated", state: "Active", story_points: null, parent_id: 100 }),
    item(16, { title: "Erwin's eight", ...erwin, story_points: 8, parent_id: 100 }),
    item(17, { title: "Dropped", state: "Removed", story_points: 5, parent_id: 100 }),
    item(31, { title: "Transcoder", story_points: 3, parent_id: 300 }),
  ];
}

/** AT-5: plan S23, which already holds a 3-SP story. */
export function planSprintTeam(): PlanItem[] {
  return [
    feature(100, "Media_Store Read support", { target_date: "2026-12-31T00:00:00Z" }),
    item(41, { title: "Already in S23", state: "Active", story_points: 3, iteration_path: "OneWork\\S23", parent_id: 100 }),
    item(42, { title: "Carried from S22", story_points: 3, iteration_path: "OneWork\\S22", parent_id: 100 }),
    item(43, { title: "Two pointer", story_points: 2, parent_id: 100, order: 1 }),
    item(44, { title: "Unestimated one", story_points: null, parent_id: 100, order: 2 }),
    item(45, { title: "Nobody's yet", assigned_to: null, assigned_to_me: false, story_points: 5, parent_id: 100, order: 3 }),
  ];
}

/** planning-tasks AT-1..AT-5: a sprint story with tasks of every kind, a resolved one, and one without tasks. */
export function taskTeam(): PlanItem[] {
  const task = (id: number, title: string, state: string, over: Partial<PlanItem> = {}) =>
    item(id, { kind: "Task", title, state, story_points: null, iteration_path: "OneWork\\S22", parent_id: 3, ...over });
  return [
    feature(200, "Audio Transcoding", { target_date: "2026-12-31T00:00:00Z" }),
    item(2, { title: "No tasks yet", story_points: 2, iteration_path: "OneWork\\S22", parent_id: 200 }),
    item(3, { title: "AMS Application State", state: "Active", story_points: 3, iteration_path: "OneWork\\S22", parent_id: 200 }),
    item(7, { title: "Already resolved", state: "Resolved", story_points: 1, iteration_path: "OneWork\\S22", parent_id: 200 }),
    task(31, "Design API", "Closed"),
    task(32, "Implement handler", "Active"),
    task(33, "Write tests", "New", erwin),
    task(34, "Docs", "Resolved"),
    task(35, "Old idea", "Removed"),
    item(36, { kind: "Bug", title: "A bug", state: "New", iteration_path: "OneWork\\S22", parent_id: 3 }),
    task(71, "Done long ago", "Closed", { parent_id: 7 }),
  ];
}

/** orphan-prs AT-1..AT-5: your PRs in the in-memory ADO, relative to the fixed clock (2026-10-30). */
export function orphanPrs(): MemoryPlanningPr[] {
  const pr = (id: number, title: string, repo: string, project: string, created: string, over: Partial<MemoryPlanningPr> = {}): MemoryPlanningPr => ({
    id, title, project, project_id: `${project}-id`, repo: `${project}/${repo}`, repo_id: `${repo}-id`,
    status: "completed", draft: false, created, mine: true, ...over,
  });
  return [
    pr(101, "Fix chunk reader retries", "acs_media_sdk", "SCC", "2026-10-28T10:00:00Z", { status: "active" }),
    pr(102, "Draft: async SDK design", "acs_media_sdk", "SCC", "2026-10-27T10:00:00Z", { status: "active", draft: true }),
    pr(103, "Route Agency reviews back", "engaine", "SCC", "2026-10-29T10:00:00Z"),
    pr(104, "Other project change", "other-repo", "OneWork", "2026-10-20T10:00:00Z"),
    pr(105, "Already linked", "engaine", "SCC", "2026-10-26T10:00:00Z", { linkedTo: [3] }),
    pr(106, "Abandoned idea", "engaine", "SCC", "2026-10-25T10:00:00Z", { status: "abandoned" }),
    pr(107, "Someone else's", "engaine", "SCC", "2026-10-24T10:00:00Z", { mine: false }),
    pr(108, "Old August PR", "engaine", "SCC", "2026-08-15T10:00:00Z"),
  ];
}
