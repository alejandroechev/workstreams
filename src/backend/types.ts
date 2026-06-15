// @test-skip: Type-only interface; behaviour covered by MemoryBackend + TauriBackend tests.
import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";
import type {
  ChunkInput,
  ChunkWithDetails,
  DiffComment,
  DiffReview,
  DiffSource,
  DiffChunk,
} from "../domain/diff-review";
import type { FileComment, ImportedCommentInput, ImportSummary } from "../domain/file-comments";

export interface FileSearchMatch {
  path: string;
  line_number: number;
  line_text: string;
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
  // Scrollback
  saveScrollback(tileId: string, data: string): Promise<void>;
  loadScrollback(tileId: string): Promise<string | null>;
  // Session poller
  watchSession(tileId: string, sessionName: string): Promise<void>;
  unwatchSession(tileId: string): Promise<void>;
  // File search
  searchFiles(directory: string, query: string): Promise<string[]>;
  searchInFiles(directory: string, query: string, limit?: number): Promise<FileSearchMatch[]>;
  /** Bump the global search epoch so any in-flight search bails out on its next iteration. */
  cancelSearches(): Promise<void>;
  // Git diff
  gitDiffFiles(directory: string, mode: string): Promise<string[]>;
  gitDiffFile(directory: string, filePath: string, mode: string): Promise<string>;
  gitDiffFilesWithStatus(directory: string, mode: string): Promise<Array<{ path: string; status: "A" | "M" | "D" | "R" }>>;
  gitDiffFileSides(directory: string, filePath: string, mode: string): Promise<{ before: string; after: string }>;
  // Git log & branch
  gitLog(directory: string, limit?: number): Promise<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>>;
  gitShowCommit(directory: string, hash: string): Promise<string>;
  gitCurrentBranch(directory: string): Promise<string>;
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
  /**
   * Subscribe the backend to fs-changes under
   * `<session>/files/features/` AND to mtime advances on the session
   * SQLite file. Coalesced into a single `session-features-changed`
   * Tauri event with `{ sessionId }` payload. Idempotent: calling
   * twice for the same sessionId is a no-op. Memory backend is a no-op.
   */
  watchSessionFeatures(sessionId: string): Promise<void>;
  unwatchSessionFeatures(sessionId: string): Promise<void>;
  // Diff Review (ADR 007)
  createDiffReview(workstreamId: string, diffSource: DiffSource, sourceRef: string | null): Promise<DiffReview>;
  listActiveDiffReviews(workstreamId: string): Promise<DiffReview[]>;
  createOrFocusDiffReviewTile(workstreamId: string, reviewId: string): Promise<Tile>;
  setReviewPlan(reviewId: string, planJson: string, chunks: ChunkInput[]): Promise<void>;
  getReview(reviewId: string): Promise<DiffReview>;
  listChunks(reviewId: string): Promise<DiffChunk[]>;
  getChunkDetails(chunkId: string): Promise<ChunkWithDetails>;
  activateChunk(reviewId: string, chunkId: string): Promise<void>;
  ackChunk(chunkId: string, state: "approved" | "commented" | "seen"): Promise<void>;
  addComment(chunkId: string, anchorFile: string, anchorLineStart: number, anchorLineEnd: number, text: string): Promise<DiffComment>;
  completeReview(reviewId: string): Promise<{ exported_path: string }>;
  detectDrift(reviewId: string): Promise<string[]>;
  // File comments (inline per-workstream comments + ADO PR import)
  listFileComments(workstreamId: string, absolutePath: string): Promise<FileComment[]>;
  addFileComment(
    workstreamId: string,
    absolutePath: string,
    anchorLineStart: number,
    anchorLineEnd: number,
    anchorText: string | null,
    bodyMd: string,
  ): Promise<FileComment>;
  updateFileComment(id: string, bodyMd: string): Promise<FileComment>;
  deleteFileComment(id: string): Promise<void>;
  importPrComments(
    workstreamId: string,
    items: ImportedCommentInput[],
  ): Promise<ImportSummary>;
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
