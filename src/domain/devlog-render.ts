/**
 * Devlog page renderer.
 *
 * This is the payoff for the whole feature. Across 30 real devlog days, **76%
 * of every page was copied verbatim from the day before** and only ~11 of 61
 * tasks were actually touched. The page is overwhelmingly derived state being
 * retyped by hand, so the fix is to record the ~24% that is genuinely new and
 * generate the rest.
 *
 * Three rules make the generated page smaller than the hand-written one it
 * replaces, rather than merely different:
 *
 * 1. **Completed work appears only on the day it finished.** That is precisely
 *    the ✅ backlog that made each page grow without bound.
 * 2. **Only manual notes reach the page.** Auto events (board moves, commits,
 *    sessions) stay in the app; the hand-written archive never contained
 *    commit logs, and including them would bury the context worth re-reading.
 * 3. **Touched tasks are marked**, surfacing the 24% that the copy-paste habit
 *    hid inside a wall of unchanged lines.
 *
 * Section headings are a breadcrumb over the task's labels **in their stored
 * order**. The bake-off prototype recalled 96.9% of task lines but differed in
 * section order on 28 of 29 days; an explicit order is what closes that gap.
 *
 * The output is one-way. Nothing here ever reads a page back, so the wiki
 * stays what it was asked to be: a searchable archive, not a second database.
 */
import type { Task, TaskEvent, Label } from "./tasks";
import { completionDate, eventsForTask, sortEvents, toLocalDate } from "./tasks";
import type { Workstream } from "./types";
import { statusEmoji, flagEmoji, isTerminalStatus, TASK_FLAGS } from "./task-status";

/** Front-matter key proving a page came from here. Guards against clobbering. */
export const GENERATED_BY_MARKER = "generated_by: workstreams";

/** Heading used for tasks that carry no labels at all. */
export const NO_LABEL_HEADING = "No label";

export interface RenderDevlogInput {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  tasks: Task[];
  events: TaskEvent[];
  labels: Label[];
  workstreams: Workstream[];
}

/**
 * Whether a file was produced by this renderer.
 *
 * Deliberately strict: the user's wiki holds a year of hand-written days in the
 * same folder, and overwriting one would be unrecoverable. Anything without our
 * exact marker inside leading front matter is treated as somebody else's.
 */
export function isGeneratedByUs(content: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return false;
  return content.slice(4, end).includes(GENERATED_BY_MARKER);
}

function statusPrefix(task: Pick<Task, "status" | "flags">): string {
  const flags = TASK_FLAGS.filter((f) => task.flags.includes(f.id)).map((f) => flagEmoji(f.id));
  // Flags stack in front of the status glyph, which is how the archive already
  // writes them (`‼️🕵️offline sdk write path impl`).
  return [...flags, statusEmoji(task.status)].join("");
}

/** `- ‼️🕵️ **title**` with no stray space when there is no glyph at all. */
function taskBullet(task: Task, workstreams: Workstream[], touched: boolean): string {
  const prefix = statusPrefix(task);
  const head = prefix ? `- ${prefix} **${task.title}**` : `- **${task.title}**`;

  const parts = [head];
  const ws = task.workstreamId
    ? workstreams.find((w) => w.id === task.workstreamId)
    : undefined;
  if (ws) parts.push(`\`ws:${ws.name}\``);
  if (touched) parts.push("← touched today");
  return parts.join("  ·  ").replace("  ·  ← touched today", "  ← touched today");
}

/**
 * Whether a task belongs on this day's page.
 *
 * Open work always does. Finished work does only on its completion day -- that
 * single rule is what stops the page growing forever. A terminal task with no
 * timestamp is a data defect rather than old work, so it stays visible instead
 * of disappearing with no trace.
 */
function belongsOnDay(task: Task, date: string): boolean {
  if (!isTerminalStatus(task.status)) return true;
  const finished = completionDate(task);
  return finished === null || finished === date;
}

function headingFor(task: Task, labels: Label[]): string {
  if (task.labelIds.length === 0) return NO_LABEL_HEADING;
  return task.labelIds
    .map((id) => labels.find((l) => l.id === id)?.name ?? id)
    .join(" › ");
}

export function renderDevlogDay(input: RenderDevlogInput): string {
  const { date, tasks, events, labels, workstreams } = input;

  const notesByTask = new Map<string, TaskEvent[]>();
  for (const event of events) {
    // Auto events are in-app history, not archive content.
    if (event.source !== "manual") continue;
    if (toLocalDate(event.at) !== date) continue;
    const list = notesByTask.get(event.taskId) ?? [];
    list.push(event);
    notesByTask.set(event.taskId, list);
  }

  const touched = new Set(
    events.filter((e) => toLocalDate(e.at) === date).map((e) => e.taskId),
  );

  // Insertion order is preserved, so sections appear in the order their first
  // task does rather than alphabetically -- which is what a reader expects
  // from a log and what the prototype got wrong.
  const sections = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!belongsOnDay(task, date)) continue;
    const heading = headingFor(task, labels);
    const list = sections.get(heading) ?? [];
    list.push(task);
    sections.set(heading, list);
  }

  const lines: string[] = [
    "---",
    `date: ${date}`,
    GENERATED_BY_MARKER,
    "---",
    "",
    `# ${date}`,
    "",
  ];

  for (const [heading, sectionTasks] of sections) {
    lines.push(`## ${heading}`, "");
    for (const task of sectionTasks) {
      lines.push(taskBullet(task, workstreams, touched.has(task.id)));

      for (const subtask of task.subtasks) {
        const glyph = statusEmoji(subtask.status);
        lines.push(glyph ? `  - ${glyph} ${subtask.title}` : `  - ${subtask.title}`);
      }
      for (const link of task.links) {
        lines.push(`  - ${link}`);
      }
      for (const note of sortEvents(eventsForTask(notesByTask.get(task.id) ?? [], task.id))) {
        const time = new Date(note.at);
        const hh = String(time.getHours()).padStart(2, "0");
        const mm = String(time.getMinutes()).padStart(2, "0");
        lines.push(`  - _${hh}:${mm}_ — ${note.text}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
