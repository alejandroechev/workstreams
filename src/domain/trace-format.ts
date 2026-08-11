/**
 * On-disk format for a recorded code walkthrough.
 *
 * A trace is an **ordered list of source locations** captured by stepping a
 * single Rust `#[test]` under `lldb-dap`. It answers "what actually ran, in
 * what order" — including which branch was taken, which no static tour can
 * know.
 *
 * ## Why a versioned file rather than a DB row
 *
 * The JSON file is the source of truth: portable (record on macOS, replay on
 * Windows), hand-inspectable, and writable by a CLI that has no business
 * knowing about the app's SQLite database. The DB stores only an index so the
 * UI's trace list is fast without parsing every file.
 *
 * ## Reserved fields
 *
 * v1 records **no variable values** — a step is a location, nothing more. The
 * `vars` field is deliberately *absent* rather than emitted empty: writing
 * `{}` on thousands of steps bloats every file for a feature that doesn't
 * exist yet, and readers can treat "missing" as "not captured", which is the
 * truth. Adding values later bumps nothing and migrates nothing.
 *
 * ## Why `hits` exists
 *
 * A raw step trace repeats the same line many times. A line such as
 * `Some(s) if s.trim().starts_with('/')` makes several std calls, and the
 * recorder steps *out* of each one — landing back on that same line every
 * time. Those repeats are debugger mechanics, not execution history, so
 * consecutive identical locations are collapsed into a `hits` count. Loop
 * revisits survive the collapse, because control returns via a different line
 * first.
 */

/** Schema version understood by this build. */
export const TRACE_FORMAT_VERSION = 1;

export interface TraceStep {
  /** Repo-relative path, so a trace survives being moved between machines. */
  readonly file: string;
  /** 1-based line number, matching DAP's `linesStartAt1`. */
  readonly line: number;
  /** Demangled function name (hash suffix stripped). */
  readonly function: string;
  /**
   * How many consecutive raw steps collapsed into this one. Present only when
   * greater than 1 — absence means "recorded once".
   */
  readonly hits?: number;
  /**
   * Call-stack depth at this step, as reported by the debugger.
   *
   * Absolute rather than relative — a Rust test sits ~22 frames inside the
   * libtest harness, so these start in the twenties. Only *comparisons*
   * between steps are meaningful.
   *
   * Optional because traces recorded before it was captured have none; readers
   * fall back to comparing function names, which is right except under
   * recursion (where the caller shares the callee's name).
   */
  readonly depth?: number;
}

export interface TraceFile {
  readonly version: number;
  /** Fully-qualified test name, e.g. `pty::tests::resolves_shell`. */
  readonly test: string;
  /** Absolute repo root at record time; used to resolve `file` for display. */
  readonly repoRoot: string;
  /** Commit HEAD was at when recorded. Drives staleness detection. */
  readonly commitSha: string;
  /** ISO-8601 timestamp. */
  readonly recordedAt: string;
  /**
   * True when recording stopped at the step cap rather than at test exit.
   * Surfaced explicitly so a capped trace is never mistaken for a complete
   * one — a silent cut would make the reader believe execution ended early.
   */
  readonly truncated: boolean;
  readonly steps: ReadonlyArray<TraceStep>;
}

function fail(message: string): never {
  throw new Error(`Invalid trace file: ${message}`);
}

function asRecord(input: string | unknown): Record<string, unknown> {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      fail(`not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("expected a JSON object at the top level");
  }
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    fail(`missing or empty "${field}"`);
  }
  return value;
}

function parseStep(raw: unknown, index: number): TraceStep {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`step ${index} is not an object`);
  }
  const step = raw as Record<string, unknown>;

  const file = step.file;
  if (typeof file !== "string" || file.length === 0) {
    fail(`step ${index} has a missing or empty "file"`);
  }

  const line = step.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    fail(`step ${index} has an invalid "line" (${String(line)}); expected a positive integer`);
  }

  const fn = typeof step.function === "string" ? step.function : "";

  const out: { file: string; line: number; function: string; hits?: number; depth?: number } = {
    file,
    line,
    function: fn,
  };

  if (step.depth !== undefined) {
    const depth = step.depth;
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
      fail(`step ${index} has an invalid "depth" (${String(depth)}); expected a positive integer`);
    }
    out.depth = depth;
  }

  if (step.hits !== undefined) {
    const hits = step.hits;
    if (typeof hits !== "number" || !Number.isInteger(hits) || hits < 2) {
      fail(`step ${index} has an invalid "hits" (${String(hits)}); omit it unless it is 2 or more`);
    }
    out.hits = hits;
  }

  return out;
}

/**
 * Validate and type a trace, from either a JSON string or a parsed object.
 *
 * Both entry points go through the same checks so the reader never trusts its
 * input just because it arrived as an object. Throws with a message naming the
 * offending field — and, for step problems, the step index, so a fault in a
 * thousand-step trace is findable.
 */
export function parseTraceFile(input: string | unknown): TraceFile {
  const obj = asRecord(input);

  const version = obj.version;
  if (typeof version !== "number") {
    fail(`missing or non-numeric "version"`);
  }
  if (version !== TRACE_FORMAT_VERSION) {
    fail(
      `file declares version ${version}, but this build supports version ${TRACE_FORMAT_VERSION}. ` +
        `Re-record the trace.`,
    );
  }

  const test = requireString(obj, "test");
  const repoRoot = requireString(obj, "repoRoot");
  const commitSha = requireString(obj, "commitSha");
  const recordedAt = requireString(obj, "recordedAt");

  if (!Array.isArray(obj.steps)) {
    fail(`"steps" must be an array`);
  }

  return {
    version,
    test,
    repoRoot,
    commitSha,
    recordedAt,
    truncated: obj.truncated === true,
    steps: obj.steps.map(parseStep),
  };
}

/** Non-throwing form of {@link parseTraceFile}, for guards and filtering. */
export function isTraceFile(input: unknown): input is TraceFile {
  try {
    parseTraceFile(input);
    return true;
  } catch {
    return false;
  }
}
