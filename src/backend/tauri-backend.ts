import { invoke } from "@tauri-apps/api/core";
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
import type { Backend } from "./types";

export class TauriBackend implements Backend {
  async listProjects(): Promise<Project[]> {
    return invoke<Project[]>("list_projects");
  }

  async createProject(name: string, directory: string, color?: string): Promise<Project> {
    return invoke<Project>("create_project", { name, directory, color });
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<void> {
    await invoke("update_project", { id, ...updates });
  }

  async deleteProject(id: string): Promise<void> {
    await invoke("delete_project", { id });
  }

  async listWorkstreams(): Promise<Workstream[]> {
    return invoke<Workstream[]>("list_workstreams");
  }

  async createWorkstream(name: string, directory: string, opts?: { projectId?: string; workstreamType?: string; worktreeBranch?: string }): Promise<Workstream> {
    return invoke<Workstream>("create_workstream", {
      name,
      directory,
      projectId: opts?.projectId,
      workstreamType: opts?.workstreamType,
      worktreeBranch: opts?.worktreeBranch,
    });
  }

  async updateWorkstream(id: string, updates: Partial<Workstream>): Promise<void> {
    await invoke("update_workstream", { id, ...updates });
  }

  async changeWorkstreamWorktree(
    wsId: string,
    mode: "switch_existing" | "create_new",
    opts: { directory?: string; branchName?: string; folderName?: string; pullBaseFirst?: boolean }
  ): Promise<{ workstream: Workstream; affectedTileIds: string[] }> {
    const raw = await invoke<{ workstream: Workstream; affected_tile_ids: string[] }>("change_workstream_worktree", {
      wsId,
      mode,
      directory: opts.directory ?? null,
      branchName: opts.branchName ?? null,
      folderName: opts.folderName ?? null,
      pullBaseFirst: opts.pullBaseFirst ?? null,
    });
    return { workstream: raw.workstream, affectedTileIds: raw.affected_tile_ids };
  }

  async deleteWorkstream(id: string): Promise<void> {
    await invoke("delete_workstream", { id });
  }

  async listTiles(workstreamId: string): Promise<Tile[]> {
    return invoke<Tile[]>("list_tiles", { workstreamId });
  }

  async createTile(workstreamId: string, tileType: TileType, title: string, configJson: string): Promise<Tile> {
    return invoke<Tile>("create_tile", { workstreamId, tileType, title, configJson });
  }

  async deleteTile(tileId: string): Promise<void> {
    await invoke("delete_tile", { tileId });
  }

  async updateTileConfig(id: string, configJson: string, title?: string): Promise<void> {
    await invoke("update_tile_config", { tileId: id, configJson, title });
  }

  async getLayout(workstreamId: string): Promise<WorkstreamLayout> {
    return invoke<WorkstreamLayout>("get_layout", { workstreamId });
  }

  async updateLayout(workstreamId: string, updates: Partial<WorkstreamLayout>): Promise<void> {
    await invoke("update_layout", {
      workstreamId,
      ...(updates.tile_order_json !== undefined ? { tileOrderJson: updates.tile_order_json } : {}),
      ...(updates.fullscreen_tile_id !== undefined ? { fullscreenTileId: updates.fullscreen_tile_id } : {}),
      ...(updates.focused_tile_id !== undefined ? { focusedTileId: updates.focused_tile_id } : {}),
      ...(updates.layout_mode !== undefined ? { layoutMode: updates.layout_mode } : {}),
    });
  }

  async readFile(path: string): Promise<string> {
    return invoke<string>("read_file", { path });
  }

  async listDirectory(path: string): Promise<Array<{ name: string; is_dir: boolean; modified_epoch: number; size: number }>> {
    return invoke<Array<{ name: string; is_dir: boolean; modified_epoch: number; size: number }>>("list_directory", { path });
  }

  async createFile(path: string): Promise<void> {
    await invoke("create_file", { path });
  }

  async createDirectory(path: string): Promise<void> {
    await invoke("create_directory", { path });
  }

  async detectGitInfo(directory: string): Promise<{ repo: string | null; branch: string | null }> {
    const [repo, branch] = await invoke<[string | null, string | null]>("detect_git_info", { directory });
    return { repo, branch };
  }

  async spawnTerminal(tileId: string, cwd: string, command?: string, args?: string[], rows?: number, cols?: number): Promise<void> {
    await invoke("spawn_terminal", {
      tileId,
      cwd,
      command: command ?? null,
      args: args ?? null,
      rows: rows ?? 30,
      cols: cols ?? 120,
    });
  }

  async spawnCopilotSession(tileId: string, cwd: string, resumeSessionId?: string | null, rows?: number, cols?: number, command?: string | null): Promise<number | null> {
    const pid = await invoke<number | null>("spawn_copilot_session", {
      tileId,
      cwd,
      resumeSessionId: resumeSessionId ?? null,
      rows: rows ?? 30,
      cols: cols ?? 120,
      command: command ?? null,
    });
    return pid ?? null;
  }

  async writeToTerminal(tileId: string, data: string): Promise<void> {
    await invoke("write_to_pty", { tileId, data });
  }

  async resizeTerminal(tileId: string, rows: number, cols: number): Promise<void> {
    await invoke("resize_pty", { tileId, rows, cols });
  }

  async closeTerminal(tileId: string): Promise<void> {
    await invoke("close_terminal", { tileId });
  }

  async saveScrollback(tileId: string, scrollback: string): Promise<void> {
    await invoke("save_scrollback", { tileId, scrollback });
  }

  async loadScrollback(tileId: string): Promise<string | null> {
    return invoke<string | null>("load_scrollback", { tileId });
  }

  async watchSession(tileId: string, sessionName: string): Promise<void> {
    await invoke("watch_session", { tileId, sessionName });
  }

  async unwatchSession(tileId: string): Promise<void> {
    await invoke("unwatch_session", { tileId });
  }

  async searchFiles(directory: string, query: string): Promise<string[]> {
    return invoke<string[]>("search_files", { directory, query });
  }

  async searchInFiles(directory: string, query: string, limit?: number): Promise<import("./types").FileSearchMatch[]> {
    return invoke<import("./types").FileSearchMatch[]>("search_in_files", { directory, query, limit });
  }

  async cancelSearches(): Promise<void> {
    await invoke("cancel_searches");
  }

  async gitDiffFiles(directory: string, mode: string): Promise<string[]> {
    return invoke<string[]>("git_diff_files", { directory, mode });
  }

  async gitDiffFile(directory: string, filePath: string, mode: string): Promise<string> {
    return invoke<string>("git_diff_file", { directory, filePath, mode });
  }

  async gitDiffFilesWithStatus(directory: string, mode: string): Promise<Array<{ path: string; status: "A" | "M" | "D" | "R" }>> {
    const raw = await invoke<Array<[string, string]>>("git_diff_files_with_status", { directory, mode });
    return raw.map(([path, status]) => ({
      path,
      status: (status === "A" || status === "D" || status === "R" ? status : "M") as "A" | "M" | "D" | "R",
    }));
  }

  async gitDiffFileSides(directory: string, filePath: string, mode: string): Promise<{ before: string; after: string }> {
    const [before, after] = await invoke<[string, string]>("git_diff_file_sides", { directory, filePath, mode });
    return { before, after };
  }

  async gitLog(directory: string, limit?: number): Promise<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>> {
    return invoke<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>>("git_log", { directory, limit: limit ?? null });
  }

  async gitShowCommit(directory: string, hash: string): Promise<string> {
    return invoke<string>("git_show_commit", { directory, hash });
  }

  async gitCurrentBranch(directory: string): Promise<string> {
    return invoke<string>("git_current_branch", { directory });
  }

  async gitBranchTrackingInfo(directory: string): Promise<{ ahead: number; behind: number; remoteHeadShort: string }> {
    const [ahead, behind, remoteHeadShort] = await invoke<[number, number, string]>("git_branch_tracking_info", { directory });
    return { ahead, behind, remoteHeadShort };
  }

  async discoverCopilotConfig(workstreamDir?: string): Promise<CopilotConfigItem[]> {
    return invoke<CopilotConfigItem[]>("discover_copilot_config", { workstreamDir: workstreamDir ?? null });
  }

  async listSessionPlans(sessionId: string): Promise<import("./types").SessionPlanEntry[]> {
    return invoke<import("./types").SessionPlanEntry[]>("query_session_plans", { sessionId });
  }

  async getCurrentSessionPlan(sessionId: string): Promise<string | null> {
    return invoke<string | null>("query_session_current_plan", { sessionId });
  }

  async listSessionTodoDeps(sessionId: string): Promise<import("./types").SessionTodoDep[]> {
    return invoke<import("./types").SessionTodoDep[]>("query_session_todo_deps", { sessionId });
  }

  async listSessionTodos(sessionId: string): Promise<import("./types").SessionTodo[]> {
    return invoke<import("./types").SessionTodo[]>("query_session_todos", { sessionId });
  }

  async listSessionFeatures(sessionId: string): Promise<import("./types").SessionFeaturesPayload> {
    return invoke<import("./types").SessionFeaturesPayload>("list_session_features", { sessionId });
  }

  async completeSessionPlan(sessionId: string, planId: string): Promise<void> {
    await invoke("complete_session_plan", { sessionId, planId });
  }

  async watchSessionFeatures(sessionId: string): Promise<void> {
    await invoke("watch_session_features", { sessionId });
  }

  async unwatchSessionFeatures(sessionId: string): Promise<void> {
    await invoke("unwatch_session_features", { sessionId });
  }

  async createDiffReview(workstreamId: string, diffSource: DiffSource, sourceRef: string | null): Promise<DiffReview> {
    return invoke<DiffReview>("create_diff_review", { workstreamId, diffSource, sourceRef });
  }

  async listActiveDiffReviews(workstreamId: string): Promise<DiffReview[]> {
    return invoke<DiffReview[]>("list_active_diff_reviews", { workstreamId });
  }

  async createOrFocusDiffReviewTile(workstreamId: string, reviewId: string): Promise<Tile> {
    return invoke<Tile>("create_or_focus_diff_review_tile", { workstreamId, reviewId });
  }

  async setReviewPlan(reviewId: string, planJson: string, chunks: ChunkInput[]): Promise<void> {
    await invoke("set_review_plan", { reviewId, planJson, chunks });
  }

  async getReview(reviewId: string): Promise<DiffReview> {
    return invoke<DiffReview>("get_review", { reviewId });
  }

  async listChunks(reviewId: string): Promise<DiffChunk[]> {
    return invoke<DiffChunk[]>("list_chunks", { reviewId });
  }

  async getChunkDetails(chunkId: string): Promise<ChunkWithDetails> {
    return invoke<ChunkWithDetails>("get_chunk_details", { chunkId });
  }

  async activateChunk(reviewId: string, chunkId: string): Promise<void> {
    await invoke("activate_chunk", { reviewId, chunkId });
  }

  async ackChunk(chunkId: string, state: "approved" | "commented" | "seen"): Promise<void> {
    await invoke("ack_chunk", { chunkId, state });
  }

  async addComment(chunkId: string, anchorFile: string, anchorLineStart: number, anchorLineEnd: number, text: string): Promise<DiffComment> {
    return invoke<DiffComment>("add_comment", { chunkId, anchorFile, anchorLineStart, anchorLineEnd, text });
  }

  async completeReview(reviewId: string): Promise<{ exported_path: string }> {
    return invoke<{ exported_path: string }>("complete_review", { reviewId });
  }

  async detectDrift(reviewId: string): Promise<string[]> {
    return invoke<string[]>("detect_drift", { reviewId });
  }

  async listFileComments(workstreamId: string, absolutePath: string): Promise<FileComment[]> {
    return invoke<FileComment[]>("list_file_comments", { workstreamId, absolutePath });
  }

  async addFileComment(
    workstreamId: string,
    absolutePath: string,
    anchorLineStart: number,
    anchorLineEnd: number,
    anchorText: string | null,
    bodyMd: string,
  ): Promise<FileComment> {
    return invoke<FileComment>("add_file_comment", {
      workstreamId,
      absolutePath,
      anchorLineStart,
      anchorLineEnd,
      anchorText,
      bodyMd,
    });
  }

  async updateFileComment(id: string, bodyMd: string): Promise<FileComment> {
    return invoke<FileComment>("update_file_comment", { id, bodyMd });
  }

  async deleteFileComment(id: string): Promise<void> {
    return invoke("delete_file_comment", { id });
  }

  async importPrComments(
    workstreamId: string,
    items: ImportedCommentInput[],
  ): Promise<ImportSummary> {
    return invoke<ImportSummary>("import_pr_comments", { workstreamId, items });
  }
}
