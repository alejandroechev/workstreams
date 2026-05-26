// @test-skip: Type-only interface; behaviour covered by MemoryBackend + TauriBackend tests.
import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";
import type {
  ChunkWithDetails,
  DiffComment,
  DiffReview,
  DiffSource,
  DiffChunk,
} from "../domain/diff-review";

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
   * Spawn agency.exe for a copilot session and register a pending PID
   * correlation with the backend session poller so it can identify the
   * resulting session-state directory without fuzzy matching.
   * Returns the child PID (or null on memory backend).
   */
  spawnCopilotSession(tileId: string, cwd: string, resumeSessionId?: string | null, rows?: number, cols?: number): Promise<number | null>;
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
  // Git log & branch
  gitLog(directory: string, limit?: number): Promise<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>>;
  gitShowCommit(directory: string, hash: string): Promise<string>;
  gitCurrentBranch(directory: string): Promise<string>;
  // Copilot config discovery
  discoverCopilotConfig(workstreamDir?: string): Promise<CopilotConfigItem[]>;
  // Plan / todo introspection of a Copilot session's session.db
  listSessionPlans(sessionId: string): Promise<SessionPlanEntry[]>;
  getCurrentSessionPlan(sessionId: string): Promise<string | null>;
  listSessionTodoDeps(sessionId: string): Promise<SessionTodoDep[]>;
  listSessionTodos(sessionId: string): Promise<SessionTodo[]>;
  // Diff Review (ADR 007)
  createDiffReview(workstreamId: string, diffSource: DiffSource, sourceRef: string | null): Promise<DiffReview>;
  setReviewPlan(reviewId: string, planJson: string): Promise<void>;
  getReview(reviewId: string): Promise<DiffReview>;
  listChunks(reviewId: string): Promise<DiffChunk[]>;
  getChunkDetails(chunkId: string): Promise<ChunkWithDetails>;
  activateChunk(reviewId: string, chunkId: string): Promise<void>;
  ackChunk(chunkId: string, state: "approved" | "commented" | "seen"): Promise<void>;
  addComment(chunkId: string, anchorFile: string, anchorLineStart: number, anchorLineEnd: number, text: string): Promise<DiffComment>;
  completeReview(reviewId: string): Promise<{ exported_path: string }>;
  detectDrift(reviewId: string): Promise<string[]>;
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
