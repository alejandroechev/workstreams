// @test-skip: Type-only interface; behaviour covered by MemoryBackend + TauriBackend tests.
import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";
import type { SessionFileComment } from "../domain/file-comments";
import type { TraceFile } from "../domain/trace-format";
import type { Review, ReviewComment, ChangedFile, DiffSides } from "../domain/code-review";
import type {
  Task,
  Subtask,
  Label,
  TaskEvent,
  TaskEventKind,
  TaskEventSource,
} from "../domain/tasks";
import type { TaskStatus, TaskFlag } from "../domain/task-status";
import type {
  LoopRun,
  LoopRunSummary,
  LoopDefinitionCatalog,
  LoopSpec,
  LoopSpecDraft,
  LoopSummary,
  PersistedLoopSnapshot,
} from "../domain/loop";

/** Writable fields on a task. Labels go through `setTaskLabels`. */
export interface TaskUpdate {
  title?: string;
  status?: TaskStatus;
  flags?: TaskFlag[];
  workstreamId?: string | null;
  links?: string[];
  /** Free-form scratchpad. Fully mutable, unlike an event. */
  notes?: string;
}

export interface FileSearchMatch {
  path: string;
  line_number: number;
  line_text: string;
}

/** Query semantics for content search. Defaults: case-insensitive, literal. */
export interface ContentSearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
}

export interface Backend {
  // Projects
  listProjects(): Promise<Project[]>;
  createProject(name: string, directory: string, color?: string): Promise<Project>;
  updateProject(id: string, updates: Partial<Project>): Promise<void>;
  deleteProject(id: string): Promise<void>;
  // Workstreams
  listWorkstreams(): Promise<Workstream[]>;
  createWorkstream(name: string, directory: string, opts?: { projectId?: string; workstreamType?: string; worktreeBranch?: string }): Promise<Workstream>;
  updateWorkstream(id: string, updates: Partial<Workstream>): Promise<void>;
  changeWorkstreamWorktree(
    wsId: string,
    mode: "switch_existing" | "create_new",
    opts: { directory?: string; branchName?: string; folderName?: string; pullBaseFirst?: boolean }
  ): Promise<{ workstream: Workstream; affectedTileIds: string[] }>;
  deleteWorkstream(id: string): Promise<void>;
  // Tiles
  listTiles(workstreamId: string): Promise<Tile[]>;
  createTile(workstreamId: string, type: TileType, title: string, config: string): Promise<Tile>;
  deleteTile(id: string): Promise<void>;
  updateTileConfig(id: string, configJson: string, title?: string): Promise<void>;
  // Layout
  getLayout(workstreamId: string): Promise<WorkstreamLayout>;
  updateLayout(workstreamId: string, updates: Partial<WorkstreamLayout>): Promise<void>;
  // Files
  readFile(path: string): Promise<string>;
  listDirectory(path: string): Promise<Array<{ name: string; is_dir: boolean; modified_epoch: number; size: number }>>;
  /** Create a new empty file. Rejects if the path already exists. */
  createFile(path: string): Promise<void>;
  /** Create a new directory (and any missing parents). Rejects if the path already exists. */
  createDirectory(path: string): Promise<void>;
  detectGitInfo(directory: string): Promise<{ repo: string | null; branch: string | null }>;
  // PTY
  spawnTerminal(tileId: string, cwd: string, command?: string, args?: string[], rows?: number, cols?: number): Promise<void>;
  /**
   * Spawn a copilot session CLI for a tile and register a pending PID
   * correlation with the backend session poller so it can identify the
   * resulting session-state directory without fuzzy matching.
   *
   * `command` is the full command line (e.g. `agency copilot --yolo` or
   * `copilot --yolo`) — whitespace-split into program + args on the
   * Rust side. If omitted, the backend uses its compiled-in default.
   *
   * Returns the child PID (or null on memory backend).
   */
  spawnCopilotSession(tileId: string, cwd: string, resumeSessionId?: string | null, rows?: number, cols?: number, command?: string | null): Promise<number | null>;
  writeToTerminal(tileId: string, data: string): Promise<void>;
  resizeTerminal(tileId: string, rows: number, cols: number): Promise<void>;
  closeTerminal(tileId: string): Promise<void>;
  // Manual coding goal loop
  getWorkstreamLoopSnapshot(workstreamId: string): Promise<PersistedLoopSnapshot>;
  /** Every run for the workstream, newest first, for the Loops list. */
  listWorkstreamLoopRuns(workstreamId: string): Promise<LoopRunSummary[]>;
  /** Evidence for one run, so history stays readable after it finishes. */
  getLoopRunSnapshot(runId: string): Promise<PersistedLoopSnapshot>;
  getWorkstreamLoopProgressVersion(workstreamId: string): Promise<string>;
  listLoopDefinitions(workstreamId: string): Promise<LoopDefinitionCatalog>;
  saveWorkstreamLoop(workstreamId: string, input: LoopSpecDraft): Promise<LoopSpec>;
  setWorkstreamLoopEnabled(loopSpecId: string, enabled: boolean): Promise<void>;
  listWorkstreamLoopSummaries(): Promise<LoopSummary[]>;
  runWorkstreamLoopNow(workstreamId: string): Promise<LoopRun>;
  runLoopDefinitionNow(workstreamId: string, definitionPath: string): Promise<LoopRun>;
  decideLoopHumanApproval(
    runId: string,
    decision: "approve" | "revise" | "reject",
    feedback?: string,
  ): Promise<LoopRun>;
  resumeWorkstreamLoop(runId: string): Promise<LoopRun>;
  controlWorkstreamLoop(
    runId: string,
    action: "pause" | "stop" | "kill",
  ): Promise<void>;
  // Scrollback
  saveScrollback(tileId: string, data: string): Promise<void>;
  loadScrollback(tileId: string): Promise<string | null>;
  // Session poller
  watchSession(tileId: string, sessionName: string): Promise<void>;
  unwatchSession(tileId: string): Promise<void>;
  // File search
  searchFiles(directory: string, query: string): Promise<string[]>;
  searchInFiles(directory: string, query: string, limit?: number, options?: ContentSearchOptions): Promise<FileSearchMatch[]>;
  /** Bump the global search epoch so any in-flight search bails out on its next iteration. */
  cancelSearches(): Promise<void>;
  // Git diff
  gitDiffFiles(directory: string, mode: string, baseRef?: string | null): Promise<string[]>;
  gitDiffFile(directory: string, filePath: string, mode: string, baseRef?: string | null): Promise<string>;
  gitDiffFilesWithStatus(directory: string, mode: string, baseRef?: string | null): Promise<Array<{ path: string; status: "A" | "M" | "D" | "R" }>>;
  gitDiffFileSides(directory: string, filePath: string, mode: string, baseRef?: string | null): Promise<{ before: string; after: string }>;
  // Git log & branch
  gitLog(directory: string, limit?: number): Promise<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>>;
  gitShowCommit(directory: string, hash: string): Promise<string>;
  gitCurrentBranch(directory: string): Promise<string>;
  gitListBranches(directory: string): Promise<string[]>;
  /** Returns ahead/behind counts vs origin/<currentBranch> + remote head short hash. */
  gitBranchTrackingInfo(directory: string): Promise<{ ahead: number; behind: number; remoteHeadShort: string }>;
  // Copilot config discovery
  discoverCopilotConfig(workstreamDir?: string): Promise<CopilotConfigItem[]>;
  // Plan / todo introspection of a Copilot session's session.db
  listSessionPlans(sessionId: string): Promise<SessionPlanEntry[]>;
  getCurrentSessionPlan(sessionId: string): Promise<string | null>;
  listSessionTodoDeps(sessionId: string): Promise<SessionTodoDep[]>;
  listSessionTodos(sessionId: string): Promise<SessionTodo[]>;
  /**
   * Per-feature summary for the redesigned Plan tile. Joins
   * `<session>/files/features/<name>/` folder state with the session
   * SQLite `plans` + `todos` tables to produce one row per feature
   * (whichever side surfaces it). See [ADR forthcoming] and
   * `docs/features-detailed.md`.
   */
  listSessionFeatures(sessionId: string): Promise<SessionFeaturesPayload>;
  /** Mark a feature plan completed (flips plans.status, clears the
   *  active-plan pointer, rewrites plan.md front-matter). Mirrors the
   *  complete-feature-plan skill. */
  completeSessionPlan(sessionId: string, planId: string): Promise<void>;
  /**
   * Subscribe the backend to fs-changes under
   * `<session>/files/features/` AND to mtime advances on the session
   * SQLite file. Coalesced into a single `session-features-changed`
   * Tauri event with `{ sessionId }` payload. Idempotent: calling
   * twice for the same sessionId is a no-op. Memory backend is a no-op.
   */
  watchSessionFeatures(sessionId: string): Promise<void>;
  unwatchSessionFeatures(sessionId: string): Promise<void>;
  // Session.db-backed inline file comments (unify-commenting). Stored in the
  // bound Copilot session's session.db with the reviewer↔agent reply model.
  // `file` is repo-relative. Requires a linked session (throws otherwise).
  listSessionFileComments(workstreamId: string, file: string): Promise<SessionFileComment[]>;
  /**
   * Every comment in the workstream, across all files — backs the Repo
   * Explorer Comments tab, which must discover *which* files have comments.
   * Ordered by file, anchor line, then chronologically. Includes replies so
   * threads can be grouped client-side. Requires a linked session (throws).
   */
  listAllSessionFileComments(workstreamId: string): Promise<SessionFileComment[]>;
  addSessionFileComment(
    workstreamId: string,
    file: string,
    anchorLineStart: number,
    anchorLineEnd: number,
    anchorText: string | null,
    body: string,
  ): Promise<SessionFileComment>;
  replySessionFileComment(
    workstreamId: string,
    parentId: string,
    body: string,
  ): Promise<SessionFileComment>;
  updateSessionFileComment(
    workstreamId: string,
    id: string,
    body: string,
  ): Promise<SessionFileComment>;
  setSessionFileCommentStatus(
    workstreamId: string,
    id: string,
    status: string,
  ): Promise<SessionFileComment>;
  deleteSessionFileComment(workstreamId: string, id: string): Promise<void>;
  /**
   * Delete a whole thread regardless of author, for cleaning up a comment
   * whose anchor file no longer exists. `deleteSessionFileComment` stays
   * author-gated: that protects a live conversation, whereas an unreachable
   * thread has no conversation left to protect.
   */
  deleteSessionFileCommentThread(workstreamId: string, id: string): Promise<void>;
  // Code Review (ADR 014) — diff-first, session-DB backed, MCP-free
  resolveWorkstreamSession(workstreamId: string): Promise<string | null>;
  codeReviewDiffFiles(directory: string, diffSource: string, baseRef?: string | null): Promise<ChangedFile[]>;
  codeReviewDiffFileSides(directory: string, filePath: string, diffSource: string, baseRef?: string | null): Promise<DiffSides>;
  createReview(workstreamId: string, diffSource: string, baseRef?: string | null, title?: string | null): Promise<Review>;
  getActiveReview(workstreamId: string): Promise<Review | null>;
  listReviews(workstreamId: string): Promise<Review[]>;
  addReviewComment(
    workstreamId: string,
    reviewId: string,
    file: string,
    line: number,
    side: string,
    code: string | null,
    hunkHeader: string | null,
    body: string,
  ): Promise<ReviewComment>;
  listReviewComments(workstreamId: string, reviewId: string): Promise<ReviewComment[]>;
  setReviewCommentStatus(workstreamId: string, commentId: string, status: string): Promise<void>;
  completeCodeReview(workstreamId: string, reviewId: string): Promise<void>;

  // ── Code walkthrough traces ──────────────────────────────────────────
  /** Recorded traces, newest first. Scoped to a workstream when given. */
  listCodeTraces(workstreamId?: string | null): Promise<CodeTrace[]>;
  /** A single trace index row, or null when the id is unknown. */
  getCodeTrace(id: string): Promise<CodeTrace | null>;
  /** Remove an index row. Removing an unknown id is not an error. */
  deleteCodeTrace(id: string): Promise<void>;
  /**
   * Adopt a trace file written by `scripts/trace-record.mjs`. The backend
   * reads the file to derive the indexed fields, so the index cannot drift
   * from the file it points at.
   */
  indexCodeTrace(tracePath: string, workstreamId?: string | null): Promise<CodeTrace>;
  /**
   * Read and validate the trace file itself. Separate from the index because
   * replay needs the steps, while listing only needs the metadata.
   */
  readCodeTraceFile(tracePath: string): Promise<TraceFile>;
  /**
   * How far a trace has drifted from the working tree. Replay is never
   * blocked on this — the UI warns and offers a re-record.
   */
  traceStaleness(repoDir: string, recordedSha: string): Promise<TraceStaleness>;
  /**
   * Fully-qualified test names for the entry-point picker.
   *
   * `package` maps to Cargo's `-p` and is the performance lever for large
   * workspaces: only that package's test targets are built. `filter` is passed
   * to libtest's `--list` command and narrows the returned names, but cannot
   * reduce compilation work.
   */
  listRustTests(
    manifestDir: string,
    query?: { package?: string; filter?: string },
  ): Promise<string[]>;
  /**
   * Record a trace for `testName` and return the written file's path.
   *
   * Long-running (it drives a debugger step by step), so callers should show
   * progress rather than blocking. Emits `trace-record-progress` events.
   */
  recordCodeTrace(
    testName: string,
    manifestDir: string,
    repoRoot: string,
    /** Copilot session that owns the trace; scopes where it is written. */
    sessionId?: string | null,
    maxSteps?: number,
    packageName?: string | null,
  ): Promise<string>;

  // ── Project tracking ──────────────────────────────────────────────────
  // Tasks are global, not workstream-scoped: a task may have no workstream,
  // and a workstream may have no task. See ADR on project tracking.

  /** Every task, with its subtasks and resolved label ids attached. */
  listTasks(): Promise<Task[]>;
  createTask(
    title: string,
    opts?: { status?: TaskStatus; workstreamId?: string | null; labelNames?: string[] },
  ): Promise<Task>;
  updateTask(id: string, updates: TaskUpdate): Promise<void>;
  deleteTask(id: string): Promise<void>;

  listLabels(): Promise<Label[]>;
  /**
   * Replace a task's labels, resolving names case-insensitively so that
   * `ai crew` reuses `AI Crew` instead of forking it. Returns the full label
   * set afterwards so callers can refresh without a second round trip.
   */
  setTaskLabels(taskId: string, labelNames: string[]): Promise<Label[]>;

  createSubtask(taskId: string, title: string): Promise<Subtask>;
  updateSubtask(id: string, updates: { title?: string; status?: TaskStatus }): Promise<void>;
  deleteSubtask(id: string): Promise<void>;

  /** Chronological. Omit `taskId` for every event across all tasks. */
  listTaskEvents(taskId?: string): Promise<TaskEvent[]>;
  addTaskEvent(
    taskId: string,
    kind: TaskEventKind,
    text: string,
    source?: TaskEventSource,
  ): Promise<TaskEvent>;
  /**
   * Delete an event. There is deliberately **no** `updateTaskEvent`: an event
   * may be removed (it never happened) but its text can never be rewritten,
   * so the log can never quietly disagree with the exported archive.
   */
  deleteTaskEvent(id: string): Promise<void>;

  /**
   * Write a rendered devlog page into `directory`, optionally committing and
   * pushing. Rendering happens in TypeScript; this only persists the result.
   *
   * Never overwrites a file it did not generate -- see `DevlogExportResult`
   * `wroteAlongside`.
   */
  exportDevlogDay(
    directory: string,
    date: string,
    content: string,
    opts?: { commit?: boolean; push?: boolean },
  ): Promise<DevlogExportResult>;
}

export interface DevlogExportResult {
  path: string;
  /** True when the intended day file was not ours and was left untouched. */
  wroteAlongside: boolean;
  warning: string;
  commit: string;
  pushed: boolean;
}

export type TraceStaleness = "fresh" | "head_moved" | "tree_dirty" | "unknown";

/**
 * Index row for a recorded code walkthrough.
 *
 * The JSON file at `trace_path` is the source of truth; this is only enough
 * metadata to list and pick traces without parsing every file.
 */
export interface CodeTrace {
  id: string;
  workstream_id: string | null;
  test_name: string;
  trace_path: string;
  commit_sha: string;
  step_count: number;
  /** True when recording stopped at the step cap rather than at test exit. */
  truncated: boolean;
  recorded_at: string;
}

export interface SessionPlanEntry {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  superseded_at: string | null;
  plan_md_snapshot: string | null;
}

export interface SessionTodoDep {
  todo_id: string;
  depends_on: string;
}

export interface SessionTodo {
  id: string;
  title: string;
  description: string | null;
  status: string;
  plan_id: string | null;
}

/**
 * One feature in the linked Copilot session. Produced by joining
 * folder state (`<session>/files/features/<name>/`) with the session
 * SQLite `plans` + `todos` tables. `derivedStatus` reconciles the two.
 *
 * - `drafting`  — folder exists, no `plans` row yet (grill-me phase).
 * - `active`/`completed`/`archived` — folder + plan row, mirrors
 *   `plans.status`.
 * - `orphan`    — `plans` row exists but the folder is missing on
 *   disk (rare; usually means the user deleted the folder).
 */
export type FeatureDerivedStatus =
  | "drafting"
  | "active"
  | "completed"
  | "archived"
  | "orphan";

export interface FeatureSummary {
  /** Folder name under `<session>/files/features/`. Doubles as display name. */
  name: string;
  /** True when `<feature>/grill-me.md` exists on disk. */
  hasGrillMe: boolean;
  /** True when `<feature>/plan.md` exists on disk. */
  hasPlan: boolean;
  /** Absolute path to `grill-me.md`, or null when absent. */
  grillMePath: string | null;
  /** Absolute path to `plan.md`, or null when absent. */
  planPath: string | null;
  /** From `plans.id`. Null when the folder is in drafting state. */
  planId: string | null;
  /** From `plans.title`. Null when no `plans` row exists. */
  planTitle: string | null;
  /** From `plans.status`. Null when no `plans` row exists. */
  planStatus: "active" | "completed" | "archived" | null;
  /** From `plans.created_at`, ISO-8601. Null when no `plans` row. */
  planCreatedAt: string | null;
  /** Reconciles folder + plan state into a single status. */
  derivedStatus: FeatureDerivedStatus;
  /** Total todos for this plan, 0 when no plan exists. */
  todosTotal: number;
  /** Todos with `status='done'`. */
  todosDone: number;
  /** Todos with `status='in_progress'`. */
  todosInProgress: number;
  /** Todos with `status='blocked'`. */
  todosBlocked: number;
  /**
   * Most recent mtime across {plan.md, grill-me.md, latest todos
   * updated_at for this plan_id}. ISO-8601. Used as the default sort
   * key. Falls back to plans.created_at, then "" (sorts last) when
   * nothing is available.
   */
  lastTouchedAt: string;
}

export interface SessionFeaturesPayload {
  /**
   * Features in the linked session. Order is insertion-order from the
   * backend; the frontend re-sorts. Empty array when the session has
   * no `files/features/` directory and no `plans` rows.
   */
  features: FeatureSummary[];
  /**
   * Value of `session_state.current_plan_id` in the session SQLite,
   * or null when unset. May not match any feature in `features` —
   * the user can have legacy non-feature plans active.
   */
  currentPlanId: string | null;
}
