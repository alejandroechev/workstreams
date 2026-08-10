import { invoke } from "@tauri-apps/api/core";
import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";
import type { SessionFileComment } from "../domain/file-comments";
import type { Review, ReviewComment, ChangedFile, DiffSides } from "../domain/code-review";
import { parseTraceFile, type TraceFile } from "../domain/trace-format";
import type { Backend, CodeTrace, TraceStaleness } from "./types";

export class TauriBackend implements Backend {
  async listProjects(): Promise<Project[]> {
    return invoke<Project[]>("list_projects");
  }

  async createProject(name: string, directory: string, color?: string): Promise<Project> {
    return invoke<Project>("create_project", { name, directory, color });
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<void> {
    // Tauri maps camelCase JS keys → snake_case Rust params, so the Project
    // type's snake_case fields must be translated explicitly. `name`/`color`
    // are single words (no case difference); `copilot_command` must be sent as
    // `copilotCommand` to reach the Rust param. Other Project fields (e.g.
    // git_remote) are intentionally not writable via update_project.
    const args: Record<string, unknown> = { id };
    if (updates.name !== undefined) args.name = updates.name;
    if (updates.color !== undefined) args.color = updates.color;
    if (updates.copilot_command !== undefined) args.copilotCommand = updates.copilot_command;
    await invoke("update_project", args);
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

  async searchInFiles(directory: string, query: string, limit?: number, options?: import("./types").ContentSearchOptions): Promise<import("./types").FileSearchMatch[]> {
    return invoke<import("./types").FileSearchMatch[]>("search_in_files", { directory, query, limit, options });
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

  async listSessionFileComments(
    workstreamId: string,
    file: string,
  ): Promise<SessionFileComment[]> {
    return invoke<SessionFileComment[]>("list_session_file_comments", { workstreamId, file });
  }

  async addSessionFileComment(
    workstreamId: string,
    file: string,
    anchorLineStart: number,
    anchorLineEnd: number,
    anchorText: string | null,
    body: string,
  ): Promise<SessionFileComment> {
    return invoke<SessionFileComment>("add_session_file_comment", {
      workstreamId,
      file,
      anchorLineStart,
      anchorLineEnd,
      anchorText,
      body,
    });
  }

  async replySessionFileComment(
    workstreamId: string,
    parentId: string,
    body: string,
  ): Promise<SessionFileComment> {
    return invoke<SessionFileComment>("reply_session_file_comment", {
      workstreamId,
      parentId,
      body,
    });
  }

  async updateSessionFileComment(
    workstreamId: string,
    id: string,
    body: string,
  ): Promise<SessionFileComment> {
    return invoke<SessionFileComment>("update_session_file_comment", { workstreamId, id, body });
  }

  async setSessionFileCommentStatus(
    workstreamId: string,
    id: string,
    status: string,
  ): Promise<SessionFileComment> {
    return invoke<SessionFileComment>("set_session_file_comment_status", {
      workstreamId,
      id,
      status,
    });
  }

  async deleteSessionFileComment(workstreamId: string, id: string): Promise<void> {
    return invoke("delete_session_file_comment", { workstreamId, id });
  }

  // Code Review (ADR 014)
  async resolveWorkstreamSession(workstreamId: string): Promise<string | null> {
    return invoke<string | null>("resolve_workstream_session", { workstreamId });
  }

  async codeReviewDiffFiles(directory: string, diffSource: string, baseRef?: string | null): Promise<ChangedFile[]> {
    const rows = await invoke<[string, string][]>("code_review_diff_files", {
      directory,
      diffSource,
      baseRef: baseRef ?? null,
    });
    return rows.map(([path, status]) => ({ path, status }));
  }

  async codeReviewDiffFileSides(
    directory: string,
    filePath: string,
    diffSource: string,
    baseRef?: string | null,
  ): Promise<DiffSides> {
    const [before, after] = await invoke<[string, string]>("code_review_diff_file_sides", {
      directory,
      filePath,
      diffSource,
      baseRef: baseRef ?? null,
    });
    return { before, after };
  }

  async createReview(
    workstreamId: string,
    diffSource: string,
    baseRef?: string | null,
    title?: string | null,
  ): Promise<Review> {
    return invoke<Review>("create_review", {
      workstreamId,
      diffSource,
      baseRef: baseRef ?? null,
      title: title ?? null,
    });
  }

  async getActiveReview(workstreamId: string): Promise<Review | null> {
    return invoke<Review | null>("get_active_review", { workstreamId });
  }

  async listReviews(workstreamId: string): Promise<Review[]> {
    return invoke<Review[]>("list_reviews", { workstreamId });
  }

  async addReviewComment(
    workstreamId: string,
    reviewId: string,
    file: string,
    line: number,
    side: string,
    code: string | null,
    hunkHeader: string | null,
    body: string,
  ): Promise<ReviewComment> {
    return invoke<ReviewComment>("add_review_comment", {
      workstreamId,
      reviewId,
      file,
      line,
      side,
      code,
      hunkHeader,
      body,
    });
  }

  async listReviewComments(workstreamId: string, reviewId: string): Promise<ReviewComment[]> {
    return invoke<ReviewComment[]>("list_review_comments", { workstreamId, reviewId });
  }

  async setReviewCommentStatus(workstreamId: string, commentId: string, status: string): Promise<void> {
    return invoke("set_review_comment_status", { workstreamId, commentId, status });
  }

  async completeCodeReview(workstreamId: string, reviewId: string): Promise<void> {
    return invoke("complete_code_review", { workstreamId, reviewId });
  }

  // ── Code walkthrough traces ──────────────────────────────────────────

  async listCodeTraces(workstreamId?: string | null): Promise<CodeTrace[]> {
    return invoke<CodeTrace[]>("list_code_traces", { workstreamId: workstreamId ?? null });
  }

  async getCodeTrace(id: string): Promise<CodeTrace | null> {
    return invoke<CodeTrace | null>("get_code_trace", { id });
  }

  async deleteCodeTrace(id: string): Promise<void> {
    return invoke("delete_code_trace", { id });
  }

  async indexCodeTrace(tracePath: string, workstreamId?: string | null): Promise<CodeTrace> {
    return invoke<CodeTrace>("index_code_trace", { tracePath, workstreamId: workstreamId ?? null });
  }

  async readCodeTraceFile(tracePath: string): Promise<TraceFile> {
    // Reuse the generic file reader, then validate through the shared parser
    // so the app and the CLI agree on what a well-formed trace is.
    const raw = await invoke<{ content: string }>("read_text_file", { path: tracePath });
    return parseTraceFile(raw.content);
  }

  async traceStaleness(repoDir: string, recordedSha: string): Promise<TraceStaleness> {
    return invoke<TraceStaleness>("trace_staleness", { repoDir, recordedSha });
  }

  async listRustTests(manifestDir: string): Promise<string[]> {
    return invoke<string[]>("list_rust_tests", { manifestDir });
  }
}
