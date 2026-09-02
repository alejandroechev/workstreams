/**
 * Board selectors.
 *
 * The board's central design problem is measured, not hypothetical: of the 61
 * real open tasks, **45 sit in `in_progress`**. A plain kanban would therefore
 * render as one unreadable column and six empty ones. Two things fix that, and
 * both live here:
 *
 * - **Swimlanes by label**, which split the tall column into a dozen short
 *   rows without asking the user to change how they work.
 * - **A Done column scoped to today**, because a task's ✅ line belongs on the
 *   day it finished; keeping it forever is what made the daily page 76%
 *   copied in the first place.
 *
 * Everything here is pure, so the skew can be reproduced in tests with
 * real-shaped seed data rather than five toy cards that would hide it.
 */
import type { Task, TaskEvent, Label, Subtask } from "./tasks";
import { completionDate, derivedRepoIds, toLocalDate } from "./tasks";
import type { Workstream } from "./types";
import type { BoardColumnId, TaskStatus } from "./task-status";
import { BOARD_COLUMNS, columnForStatus, isTerminalStatus } from "./task-status";

/** Lane holding tasks that carry no labels at all. */
export const UNLABELLED_LANE_ID = "__unlabelled__";

export type ColumnBuckets<T> = Record<BoardColumnId, T[]>;

export interface BoardTask extends Task {
  /** Whether the task saw any event on the day being rendered. */
  touchedToday: boolean;
}

export interface Swimlane {
  id: string;
  name: string;
  color: string | null;
  columns: ColumnBuckets<BoardTask>;
}

function emptyBuckets<T>(): ColumnBuckets<T> {
  const out = {} as ColumnBuckets<T>;
  for (const column of BOARD_COLUMNS) out[column.id] = [];
  return out;
}

/** Bucket tasks by the column they render in (not by raw status). */
export function groupByColumn(tasks: Task[]): ColumnBuckets<Task> {
  const out = emptyBuckets<Task>();
  for (const task of tasks) out[columnForStatus(task.status)].push(task);
  return out;
}

export interface VisibleOptions {
  /** Show every finished task, not just today's. */
  showAllDone?: boolean;
}

/**
 * Drop work that finished on an earlier day.
 *
 * A terminal task with no `completedAt` is a data defect rather than old work,
 * so it stays visible: hiding it would make it unreachable from the UI with no
 * way to notice it had happened.
 */
export function visibleTasks(
  tasks: Task[],
  today: string,
  opts: VisibleOptions = {},
): Task[] {
  if (opts.showAllDone) return tasks;
  return tasks.filter((task) => {
    if (!isTerminalStatus(task.status)) return true;
    const finished = completionDate(task);
    return finished === null || finished === today;
  });
}

/** Restrict to tasks whose workstream lives in a given repo. */
export function filterByRepo(
  tasks: Task[],
  workstreams: Workstream[],
  repoId: string | null,
): Task[] {
  if (!repoId) return tasks;
  return tasks.filter((task) => derivedRepoIds(task, workstreams).includes(repoId));
}

export interface SwimlaneOptions {
  events?: TaskEvent[];
  today?: string;
}

/**
 * Split the board into one lane per label, plus a lane for unlabelled work.
 *
 * A task appears in **every** lane it is labelled with. That duplication is
 * intentional: labels are multi-valued precisely so that work spanning two
 * areas can be seen from both, which a single project pointer could never do.
 * Empty lanes are omitted so a long label list does not become a wall of
 * headers.
 */
export function swimlanes(
  tasks: Task[],
  labels: Label[],
  opts: SwimlaneOptions = {},
): Swimlane[] {
  const touched = new Set(
    (opts.events ?? [])
      .filter((e) => !opts.today || toLocalDate(e.at) === opts.today)
      .map((e) => e.taskId),
  );

  const decorate = (task: Task): BoardTask => ({ ...task, touchedToday: touched.has(task.id) });

  const lanes = new Map<string, Swimlane>();
  const laneFor = (id: string, name: string, color: string | null): Swimlane => {
    let lane = lanes.get(id);
    if (!lane) {
      lane = { id, name, color, columns: emptyBuckets<BoardTask>() };
      lanes.set(id, lane);
    }
    return lane;
  };

  for (const task of tasks) {
    const column = columnForStatus(task.status);
    const decorated = decorate(task);

    if (task.labelIds.length === 0) {
      laneFor(UNLABELLED_LANE_ID, "No label", null).columns[column].push(decorated);
      continue;
    }
    for (const labelId of task.labelIds) {
      const label = labels.find((l) => l.id === labelId);
      laneFor(labelId, label?.name ?? labelId, label?.color ?? null).columns[column].push(
        decorated,
      );
    }
  }

  // Label lanes first in the caller's label order, unlabelled work last.
  const ordered: Swimlane[] = [];
  for (const label of labels) {
    const lane = lanes.get(label.id);
    if (lane) ordered.push(lane);
  }
  for (const [id, lane] of lanes) {
    if (id !== UNLABELLED_LANE_ID && !ordered.includes(lane)) ordered.push(lane);
  }
  const orphan = lanes.get(UNLABELLED_LANE_ID);
  if (orphan) ordered.push(orphan);

  return ordered;
}

/**
 * The status a task should take when dropped on `column`, or null for a no-op.
 *
 * The null case is doing real work. Two statuses render in a column not named
 * after them -- `investigating` in In progress, `cancelled` in Done -- so a
 * drop that lands a card back where it already was must NOT rewrite its status
 * to the column's own. Doing so would silently flatten `🕵️` into `⚒️` and `❌`
 * into `✅`, destroying a distinction the exported archive relies on, purely
 * because the user picked a card up and put it down again.
 */
export function statusForDrop(task: Task, column: BoardColumnId): TaskStatus | null {
  if (columnForStatus(task.status) === column) return null;
  return column;
}

export interface SubtaskProgress {
  done: number;
  total: number;
}

/** Finished-vs-total subtasks, counting cancelled as finished like the board does. */
export function subtaskProgress(task: Task): SubtaskProgress {
  return {
    done: task.subtasks.filter((s) => isTerminalStatus(s.status)).length,
    total: task.subtasks.length,
  };
}

export interface CardSubtasks {
  shown: Subtask[];
  hidden: number;
}

/**
 * The subtasks a board card lists, and how many it had to drop.
 *
 * Finished subtasks are removed *before* the limit is applied, so the card
 * spends its few rows on work that is still open. The progress chip keeps
 * reporting the full done/total counts, so nothing is lost.
 */
export function cardSubtasks(task: Task, limit: number): CardSubtasks {
  const open = task.subtasks.filter((s) => !isTerminalStatus(s.status));
  return { shown: open.slice(0, limit), hidden: Math.max(0, open.length - limit) };
}

/**
 * Tasks that render in the In progress column.
 *
 * Keyed on the *column* rather than the raw status, so the statuses that fold
 * into it (`investigating`, and the retired `persistent`) are included — an
 * always-on "what am I doing" view that dropped them would hide live work.
 */
export function inProgressTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => columnForStatus(task.status) === "in_progress");
}
