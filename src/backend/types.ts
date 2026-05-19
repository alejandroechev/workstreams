// @test-skip: Type-only interface; behaviour covered by MemoryBackend + TauriBackend tests.
import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";

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
}
