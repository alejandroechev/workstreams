/**
 * Task domain model.
 *
 * The shape here is a direct consequence of what the real devlog turned out to
 * be, rather than a generic tracker schema:
 *
 * - **A task has at most one workstream, and may have none.** Some tasks are
 *   pure coordination with no worktree behind them; some workstreams exist
 *   with no task. Neither side can own the other.
 * - **Repos are derived, never stored.** `AI Crew` spans three repos and six of
 *   the 21 real sections have no repo at all, so a `repo_id` column would be
 *   wrong more often than right. It is a *filter*, computed from the attached
 *   workstream.
 * - **Subtasks carry a full status**, not a checkbox. The archive is full of
 *   `⚒️Addressing second round of in depth comments` nested under an
 *   in-progress parent; degrading that to "not done" would corrupt the export.
 * - **Events are immutable.** There is deliberately no `updateEvent` here --
 *   an event may be deleted (it never happened) but never rewritten.
 *
 * The devlog's deeper nesting (`🐞Bugs/Fixes → FileComments: → task`) is *not*
 * modelled as hierarchy; those levels become labels, which is what collapses an
 * irregular four-level tree into task + subtasks.
 */
import type { TaskStatus, TaskFlag } from "./task-status";
import { isTerminalStatus } from "./task-status";
import type { Workstream } from "./types";

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Subtask {
  id: string;
  title: string;
  /** Same vocabulary as a task; a subtask simply never becomes a board card. */
  status: TaskStatus;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  flags: TaskFlag[];
  labelIds: string[];
  /** 0..1. Null is the common case, not an error state. */
  workstreamId: string | null;
  subtasks: Subtask[];
  links: string[];
  /**
   * Free-form scratchpad: mutable standing context with no status and no
   * timestamp. The third concept alongside subtasks (units of work) and events
   * (things that happened) -- 74% of the nested bullets in the real devlog are
   * exactly this, and had nowhere to live before it existed.
   *
   * Unlike an event this is fully mutable, because it records current
   * understanding rather than history.
   */
  notes: string;
  createdAt: string;
  /** Set when the task reaches a terminal status; drives the Done filter. */
  completedAt: string | null;
}

export type TaskEventKind = "status" | "note" | "commit" | "session" | "workstream" | "link";

/** `auto` events are observed by the app; `manual` ones are typed by the user. */
export type TaskEventSource = "auto" | "manual";

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: TaskEventKind;
  text: string;
  at: string;
  source: TaskEventSource;
}

const newId = (): string => globalThis.crypto.randomUUID();

export function makeTask(input: {
  id?: string;
  title: string;
  status?: TaskStatus;
  flags?: TaskFlag[];
  labelIds?: string[];
  workstreamId?: string | null;
  subtasks?: Subtask[];
  links?: string[];
  notes?: string;
  createdAt?: string;
  completedAt?: string | null;
}): Task {
  const status = input.status ?? "todo";
  return {
    id: input.id ?? newId(),
    title: input.title,
    status,
    flags: input.flags ?? [],
    labelIds: input.labelIds ?? [],
    workstreamId: input.workstreamId ?? null,
    subtasks: input.subtasks ?? [],
    links: input.links ?? [],
    notes: input.notes ?? "",
    createdAt: input.createdAt ?? new Date().toISOString(),
    completedAt: input.completedAt ?? null,
  };
}

export function makeEvent(input: {
  id?: string;
  taskId: string;
  kind: TaskEventKind;
  text: string;
  at?: string;
  source?: TaskEventSource;
}): TaskEvent {
  return {
    id: input.id ?? newId(),
    taskId: input.taskId,
    kind: input.kind,
    text: input.text,
    at: input.at ?? new Date().toISOString(),
    source: input.source ?? "manual",
  };
}

/** Replaces the link rather than accumulating -- the cardinality is 0..1. */
export const attachWorkstream = (task: Task, workstreamId: string | null): Task => ({
  ...task,
  workstreamId,
});

/**
 * The repos a task touches, computed from its workstream. Returns an array
 * (not a scalar) so that widening the link to many workstreams later does not
 * change every call site.
 */
export function derivedRepoIds(task: Task, workstreams: Workstream[]): string[] {
  if (!task.workstreamId) return [];
  const ws = workstreams.find((w) => w.id === task.workstreamId);
  return ws?.project_id ? [ws.project_id] : [];
}

/** The `YYYY-MM-DD` a task finished, or null while it is still open. */
export function completionDate(task: Task): string | null {
  if (!isTerminalStatus(task.status) || !task.completedAt) return null;
  return toLocalDate(task.completedAt);
}

export const eventsForTask = (events: TaskEvent[], taskId: string): TaskEvent[] =>
  events.filter((e) => e.taskId === taskId);

/**
 * The local calendar day an ISO-8601 UTC instant falls on.
 *
 * Events are stored in UTC but the devlog page is a *local* day. Slicing the
 * UTC string would file a 21:00 EDT note under the next day -- a silent data
 * error that would only ever show up as a note appearing on the wrong page.
 */
export function toLocalDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export const sortEvents = (events: TaskEvent[]): TaskEvent[] =>
  [...events].sort((a, b) => a.at.localeCompare(b.at));

/**
 * Tasks with at least one event on `date`. Only ~11 of 61 tasks are touched on
 * a given day, which is the signal the generated page surfaces and the copied
 * daily page hid.
 */
export function touchedOn(tasks: Task[], events: TaskEvent[], date: string): Task[] {
  const ids = new Set(events.filter((e) => toLocalDate(e.at) === date).map((e) => e.taskId));
  return tasks.filter((t) => ids.has(t.id));
}
