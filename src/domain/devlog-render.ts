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
import { completionDate, sortEvents, toLocalDate } from "./tasks";
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
  // Tolerate ONE leading UTF-8 BOM and CRLF, which editors add freely, but
  // nothing else. The trailing-whitespace set below is deliberately ASCII-only
  // rather than `\s`, because JavaScript's `\s` matches U+FEFF and U+00A0
  // while Rust's `trim_end` does not. This function and `is_generated_by_us`
  // in src-tauri/src/devlog.rs must agree on every input, or the CLI and the
  // UI hold different opinions about which files may be destroyed.
  const body = content.replace(/^\uFEFF/, "").split("\r\n").join("\n");
  if (!body.startsWith("---\n")) return false;
  const end = body.indexOf("\n---", 4);
  if (end === -1) return false;
  // Exact line match, not a substring test. `not_generated_by: workstreams`
  // and `generated_by: workstreams-backup` both contain the marker, and
  // treating either as ours would authorise destroying somebody else's file.
  // Must stay in lockstep with `is_generated_by_us` in src-tauri/src/devlog.rs.
  return body
    .slice(4, end)
    .split("\n")
    .some((line) => line.replace(/[ \t\r]+$/, "") === GENERATED_BY_MARKER);
}

function statusPrefix(task: Pick<Task, "status" | "flags">): string {
  const flags = TASK_FLAGS.filter((f) => task.flags.includes(f.id)).map((f) => flagEmoji(f.id));
  // Flags stack in front of the status glyph, which is how the archive already
  // writes them (`‼️🕵️offline sdk write path impl`).
  return [...flags, statusEmoji(task.status)].join("");
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

/** Stable key for "these tasks carry the same labels, in the same order". */
function labelKey(task: Task): string {
  return task.labelIds.join("\u0000");
}

function labelNames(task: Task, labels: Label[]): string[] {
  return task.labelIds.map((id) => labels.find((l) => l.id === id)?.name ?? id);
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function renderDevlogDay(input: RenderDevlogInput): string {
  const { date, tasks, events, labels, workstreams } = input;

  // Only manual entries reach the page, and only from the day being exported.
  // Auto events (board moves, commits) are in-app history: the hand-written
  // archive never contained commit logs, and including them would bury the
  // context worth re-reading.
  const logByTask = new Map<string, TaskEvent[]>();
  for (const event of events) {
    if (event.source !== "manual") continue;
    if (toLocalDate(event.at) !== date) continue;
    const list = logByTask.get(event.taskId) ?? [];
    list.push(event);
    logByTask.set(event.taskId, list);
  }

  // Label headings are gone now that each task owns a `##`, so ordering is the
  // only thing left holding related work together. Grouping by label key keeps
  // same-labelled tasks adjacent, in the order their group first appears.
  const onDay = tasks.filter((task) => belongsOnDay(task, date));
  const groups = new Map<string, Task[]>();
  for (const task of onDay) {
    const key = labelKey(task);
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
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

  /** Emit a `### <title>` block, or nothing at all when it has no content. */
  const section = (title: string, body: string[]): void => {
    if (body.length === 0) return;
    lines.push(`### ${title}`, "", ...body, "");
  };

  for (const group of groups.values()) {
    for (const task of group) {
      const prefix = statusPrefix(task);
      lines.push(prefix ? `## ${prefix} ${task.title}` : `## ${task.title}`, "");

      const names = labelNames(task, labels);
      section("Labels", names.length ? [names.map((n) => `\`${n}\``).join(" · ")] : []);

      const ws = task.workstreamId
        ? workstreams.find((w) => w.id === task.workstreamId)
        : undefined;
      section("Workstream", ws ? [`\`ws:${ws.name}\``] : []);

      section(
        "Subtasks",
        task.subtasks.map((sub) => {
          const glyph = statusEmoji(sub.status);
          return glyph ? `- ${glyph} ${sub.title}` : `- ${sub.title}`;
        }),
      );

      section("Links", task.links.map((link) => `- ${link}`));

      // Verbatim, not bulletised. The note is already markdown, and prefixing
      // `- ` onto a line that starts with `- ` is what produced the
      // `- - Moving the miner logic` double bullet in the previous format.
      // Being a top-level block also means blank lines are ordinary paragraph
      // breaks rather than something that terminates a list.
      const notes = task.notes.trim();
      section("Notes", notes ? notes.split("\n").map((l) => l.trimEnd()) : []);

      // The presence of this section is itself the "touched that day" signal,
      // which is why there is no separate badge on the heading.
      section(
        "Event log",
        sortEvents(logByTask.get(task.id) ?? []).map((entry) => {
          const time = new Date(entry.at);
          return `- _${pad(time.getHours())}:${pad(time.getMinutes())}_ — ${entry.text}`;
        }),
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
