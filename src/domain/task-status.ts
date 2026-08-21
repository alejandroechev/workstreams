/**
 * Task status and flag vocabulary.
 *
 * This is not an invented taxonomy. Every glyph below was counted across the
 * 30 real devlog days that this feature replaces:
 *
 *   ✅ 181   ⚒️ 116   👁️ 68   🧊 39   🚗 8   ❌ 7   🕵️ 4   ❓ 3
 *
 * Three findings shaped the model:
 *
 * 1. `🕵️ investigating` appears 4 times in 30 days. A board column that is
 *    empty 99% of the time is pure cost, and investigating *is* in-progress
 *    work, so it folds into `in_progress` for placement while keeping its own
 *    glyph for the export.
 * 2. `❌ cancelled` is terminal but is not `done`. It shares the Done column
 *    rather than owning a graveyard column nobody scrolls to.
 * 3. `‼️` stacks *in front of* a status glyph in the real files
 *    (`‼️🕵️offline sdk write path impl`). A status cannot stack on a status,
 *    which is the proof that priority is a **flag** on an orthogonal axis.
 *    `❓` behaves the same way.
 *
 * `🐞Bugs/Fixes` and `🌟Features` are *not* statuses despite appearing 30 times
 * each -- they are category bullets, and they become labels (see task-labels).
 * `statusFromEmoji` must reject them or every category header in the wiki would
 * be misread as a task status.
 */

/** Board columns, in render order. */
export const BOARD_COLUMNS = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "in_review", label: "In review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

/**
 * Every status a task or subtask can hold.
 *
 * A superset of the columns. `investigating` and `cancelled` render in a
 * column they do not own, and `parked`, `delegated` and `persistent` are
 * **retired**: they own no column and cannot be selected any more, but they
 * stay in the vocabulary because rows already hold them and because `🚗`
 * appears 8 times in the real devlog -- dropping the status would strand that
 * glyph in the task title when a page is read back.
 */
export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "parked",
  "delegated",
  "persistent",
  "done",
  "investigating",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Statuses offered when setting a task's status.
 *
 * Narrower than `TASK_STATUSES`: retired statuses stay readable and renderable
 * but are no longer somewhere new work can be put.
 */
export const SELECTABLE_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "investigating",
  "done",
  "cancelled",
] as const satisfies ReadonlyArray<TaskStatus>;

/** Statuses that end a task's life -- excluded from the board after their day. */
const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "cancelled"]);

/** Statuses that render in a column other than one named after them. */
const FOLDED: Partial<Record<TaskStatus, BoardColumnId>> = {
  investigating: "in_progress",
  cancelled: "done",
  // Retired columns fold rather than vanish. A task still holding one of these
  // must land somewhere visible: returning a column that no longer exists
  // would drop it off the board with no way to reach it again.
  parked: "blocked",
  delegated: "blocked",
  persistent: "in_progress",
};

/**
 * Devlog glyph per status. `todo` is deliberately empty: plain bullets with no
 * glyph are how untouched work already appears in the real files, so emitting
 * a glyph for it would change every line of the archive.
 *
 * `🙋 delegated` is the one invention here -- the user had no glyph for it, and
 * it is checked against the others so it can never collide.
 */
const EMOJI: Record<TaskStatus, string> = {
  todo: "",
  in_progress: "⚒️",
  in_review: "👁️",
  blocked: "🧊",
  parked: "🚗",
  delegated: "🙋",
  persistent: "♾️",
  done: "✅",
  investigating: "🕵️",
  cancelled: "❌",
};

/** Flags are orthogonal to status -- a task may carry any, all, or none. */
export const TASK_FLAGS = [
  { id: "priority", label: "Priority" },
  { id: "question", label: "Open question" },
] as const;

export type TaskFlag = (typeof TASK_FLAGS)[number]["id"];

const FLAG_EMOJI: Record<TaskFlag, string> = {
  priority: "‼️",
  question: "❓",
};

/** U+FE0F. Present on some glyphs in the real files and absent on others. */
const VS16 = "\uFE0F";

const stripVs16 = (s: string) => s.split(VS16).join("");

export const statusEmoji = (status: TaskStatus): string => EMOJI[status];

export const flagEmoji = (flag: TaskFlag): string => FLAG_EMOJI[flag];

export const isTerminalStatus = (status: TaskStatus): boolean => TERMINAL.has(status);

/** Which column a status renders in. */
export const columnForStatus = (status: TaskStatus): BoardColumnId =>
  FOLDED[status] ?? (status as BoardColumnId);

/**
 * Reverse lookup, tolerant of a missing variation selector. Returns null for
 * anything that is not a status glyph -- notably the category bullets.
 */
export function statusFromEmoji(emoji: string): TaskStatus | null {
  const needle = stripVs16(emoji);
  if (!needle) return null;
  for (const status of TASK_STATUSES) {
    if (status === "todo") continue;
    if (stripVs16(EMOJI[status]) === needle) return status;
  }
  return null;
}

export interface ParsedStatusPrefix {
  status: TaskStatus;
  flags: TaskFlag[];
  text: string;
}

/** Longest-first so no glyph can be shadowed by a prefix of another. */
const STATUS_PREFIXES: ReadonlyArray<readonly [TaskStatus, string]> = TASK_STATUSES.filter(
  (s) => s !== "todo",
)
  .map((s) => [s, stripVs16(EMOJI[s])] as const)
  .sort((a, b) => b[1].length - a[1].length);

const FLAG_PREFIXES: ReadonlyArray<readonly [TaskFlag, string]> = TASK_FLAGS.map(
  (f) => [f.id, stripVs16(FLAG_EMOJI[f.id])] as const,
).sort((a, b) => b[1].length - a[1].length);

/**
 * Split a devlog bullet's leading glyphs from its text.
 *
 * Flags may precede the status (and repeat); the status may appear at most
 * once. Anything unrecognised is left in `text` untouched, which is what keeps
 * `🐞Bugs/Fixes` intact rather than being silently eaten.
 */
export function parseStatusPrefix(line: string): ParsedStatusPrefix {
  let rest = line;
  const flags: TaskFlag[] = [];
  let status: TaskStatus = "todo";

  const consume = (glyph: string): boolean => {
    if (!glyph || !rest.startsWith(glyph)) return false;
    rest = rest.slice(glyph.length);
    if (rest.startsWith(VS16)) rest = rest.slice(VS16.length);
    return true;
  };

  let progressed = true;
  while (progressed) {
    progressed = false;

    for (const [flag, glyph] of FLAG_PREFIXES) {
      if (!flags.includes(flag) && consume(glyph)) {
        flags.push(flag);
        progressed = true;
        break;
      }
    }
    if (progressed) continue;

    if (status === "todo") {
      for (const [candidate, glyph] of STATUS_PREFIXES) {
        if (consume(glyph)) {
          status = candidate;
          progressed = true;
          break;
        }
      }
    }
  }

  return { status, flags, text: rest.trimStart() };
}
