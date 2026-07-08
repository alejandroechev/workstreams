import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";
import type { FileComment, ImportedCommentInput, ImportSummary } from "../domain/file-comments";
import type { Review, ReviewComment, ChangedFile, DiffSides } from "../domain/code-review";
import { CONTENT_SEARCH_MAX_PER_FILE } from "../domain/content-search";
import type { Backend } from "./types";
import { rewriteTileCwd } from "../domain/worktree-change";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function now(): string {
  return new Date().toISOString();
}

function pathSeparator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

function parentDirectory(path: string): string {
  const separator = pathSeparator(path);
  const parts = path.split(/[/\\]/);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join(separator);
}

function lastSlashSegment(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function pathJoin(parent: string, child: string): string {
  if (!parent) return child;
  if (parent.endsWith("/") || parent.endsWith("\\")) return `${parent}${child}`;
  return `${parent}${pathSeparator(parent)}${child}`;
}

/**
 * In-memory Backend implementation for tests and offline development.
 */
export class MemoryBackend implements Backend {
  private projects = new Map<string, Project>();
  private workstreams = new Map<string, Workstream>();
  private tiles = new Map<string, Tile>();
  private layouts = new Map<string, WorkstreamLayout>();
  private scrollbacks = new Map<string, string>();
  private files = new Map<string, string>();
  private dirs = new Set<string>();
  private terminals = new Set<string>();
  private fileComments = new Map<string, FileComment>();
  // Code Review (ADR 014) offline stub state.
  private reviews = new Map<string, Review>();
  private reviewComments = new Map<string, ReviewComment>();
  private boundSessions = new Map<string, string | null>();
  private reviewChangedFiles: ChangedFile[] = [];
  private reviewDiffSides = new Map<string, DiffSides>();
  /**
   * Test/dev seed for listSessionFeatures. Maps sessionId → payload.
   * Populated via {@link seedSessionFeatures}. Default per-session
   * payload is empty features + null currentPlanId.
   */
  private sessionFeatures = new Map<string, import("./types").SessionFeaturesPayload>();

  seedFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  /**
   * Test helper: pre-populate the in-memory `listSessionFeatures`
   * response for a session id. The frontend Plan tile tests use this to drive
   * the shimmed backend without standing up real session-state folders.
   */
  seedSessionFeatures(
    sessionId: string,
    payload: import("./types").SessionFeaturesPayload,
  ): void {
    this.sessionFeatures.set(sessionId, payload);
  }

  async listProjects(): Promise<Project[]> {
    return Array.from(this.projects.values());
  }

  async createProject(name: string, directory: string, color?: string): Promise<Project> {
    const p: Project = {
      id: generateId(),
      name,
      directory,
      git_remote: null,
      color: color || "#89b4fa",
      created_at: now(),
      updated_at: now(),
    };
    this.projects.set(p.id, p);
    return p;
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<void> {
    const p = this.projects.get(id);
    if (!p) throw new Error(`Project not found: ${id}`);
    Object.assign(p, updates, { updated_at: now() });
  }

  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
  }

  async listWorkstreams(): Promise<Workstream[]> {
    return Array.from(this.workstreams.values());
  }

  async createWorkstream(name: string, directory: string, opts?: { projectId?: string; workstreamType?: string; worktreeBranch?: string }): Promise<Workstream> {
    const ws: Workstream = {
      id: generateId(),
      name,
      description: null,
      directory,
      git_repo: null,
      git_branch: null,
      status: "active",
      project_id: opts?.projectId || null,
      workstream_type: opts?.workstreamType || "standalone",
      worktree_branch: opts?.worktreeBranch || null,
      created_at: now(),
      updated_at: now(),
    };
    this.workstreams.set(ws.id, ws);
    // Auto-create a layout entry
    this.layouts.set(ws.id, {
      workstream_id: ws.id,
      layout_mode: "auto",
      focused_tile_id: null,
      fullscreen_tile_id: null,
      tile_order_json: "[]",
      updated_at: now(),
    });
    return ws;
  }

  async updateWorkstream(id: string, updates: Partial<Workstream>): Promise<void> {
    const ws = this.workstreams.get(id);
    if (!ws) throw new Error(`Workstream not found: ${id}`);
    Object.assign(ws, updates, { updated_at: now() });
  }

  async changeWorkstreamWorktree(
    wsId: string,
    mode: "switch_existing" | "create_new",
    opts: { directory?: string; branchName?: string; folderName?: string; pullBaseFirst?: boolean }
  ): Promise<{ workstream: Workstream; affectedTileIds: string[] }> {
    // pullBaseFirst is metadata-only in the memory backend (there's no
    // real git). Acknowledged for type parity.
    void opts.pullBaseFirst;
    const ws = this.workstreams.get(wsId);
    if (!ws) throw new Error(`Workstream not found: ${wsId}`);

    let finalDir: string;
    let finalBranch = ws.worktree_branch;
    if (mode === "switch_existing") {
      if (!opts.directory) throw new Error("Directory is required");
      finalDir = opts.directory;
    } else {
      if (!opts.branchName) throw new Error("Branch name is required");
      finalDir = pathJoin(parentDirectory(ws.directory ?? ""), opts.folderName || lastSlashSegment(opts.branchName));
      finalBranch = opts.branchName;
    }

    Object.assign(ws, { directory: finalDir, worktree_branch: finalBranch, updated_at: now() });

    const affectedTileIds: string[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.workstream_id !== wsId) continue;
      if (tile.tile_type !== "terminal" && tile.tile_type !== "copilot_session") continue;
      tile.config_json = rewriteTileCwd(tile.config_json, finalDir, tile.tile_type);
      tile.updated_at = now();
      affectedTileIds.push(tile.id);
    }

    return { workstream: ws, affectedTileIds };
  }

  async deleteWorkstream(id: string): Promise<void> {
    this.workstreams.delete(id);
    this.layouts.delete(id);
    // Remove associated tiles
    for (const [tileId, tile] of this.tiles) {
      if (tile.workstream_id === id) {
        this.tiles.delete(tileId);
      }
    }
  }

  async listTiles(workstreamId: string): Promise<Tile[]> {
    return Array.from(this.tiles.values()).filter((t) => t.workstream_id === workstreamId);
  }

  async createTile(workstreamId: string, tileType: TileType, title: string, configJson: string): Promise<Tile> {
    const tile: Tile = {
      id: generateId(),
      workstream_id: workstreamId,
      tile_type: tileType,
      title,
      config_json: configJson,
      created_at: now(),
      updated_at: now(),
    };
    this.tiles.set(tile.id, tile);
    return tile;
  }

  async deleteTile(id: string): Promise<void> {
    this.tiles.delete(id);
    this.terminals.delete(id);
  }

  async updateTileConfig(id: string, configJson: string, title?: string): Promise<void> {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.config_json = configJson;
    if (title) tile.title = title;
  }

  async getLayout(workstreamId: string): Promise<WorkstreamLayout> {
    const layout = this.layouts.get(workstreamId);
    if (layout) return layout;
    // Return a default layout
    return {
      workstream_id: workstreamId,
      layout_mode: "auto",
      focused_tile_id: null,
      fullscreen_tile_id: null,
      tile_order_json: "[]",
      updated_at: now(),
    };
  }

  async updateLayout(workstreamId: string, updates: Partial<WorkstreamLayout>): Promise<void> {
    const layout = this.layouts.get(workstreamId) ?? {
      workstream_id: workstreamId,
      layout_mode: "auto",
      focused_tile_id: null,
      fullscreen_tile_id: null,
      tile_order_json: "[]",
      updated_at: now(),
    };
    Object.assign(layout, updates, { updated_at: now() });
    this.layouts.set(workstreamId, layout);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async listDirectory(_path: string): Promise<Array<{ name: string; is_dir: boolean; modified_epoch: number; size: number }>> {
    return Array.from(this.files.entries()).map(([k, content]) => ({
      name: k.split("/").pop() || k,
      is_dir: false,
      modified_epoch: 0,
      size: content.length,
    }));
  }

  async createFile(path: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`A file or folder already exists at ${path}`);
    this.files.set(path, "");
  }

  async createDirectory(path: string): Promise<void> {
    const key = `${path}/.dir`;
    if (this.dirs.has(path)) throw new Error(`A file or folder already exists at ${path}`);
    this.dirs.add(path);
    // Track via a marker so listings/round-trips can observe the directory.
    if (!this.files.has(key)) this.files.set(key, "");
  }

  async detectGitInfo(_directory: string): Promise<{ repo: string | null; branch: string | null }> {
    return { repo: null, branch: null };
  }

  async spawnTerminal(tileId: string, cwd: string, command?: string, args?: string[], rows?: number, cols?: number): Promise<void> {
    this.terminals.add(tileId);
    if (typeof window !== "undefined") {
      const w = window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> };
      if (!w.__WS_INVOKE_LOG__) w.__WS_INVOKE_LOG__ = [];
      w.__WS_INVOKE_LOG__.push({
        cmd: "spawn_terminal",
        args: { tileId, cwd, command: command ?? null, args: args ?? null, rows: rows ?? null, cols: cols ?? null },
      });
    }
  }

  async spawnCopilotSession(tileId: string, cwd: string, resumeSessionId?: string | null, rows?: number, cols?: number, command?: string | null): Promise<number | null> {
    this.terminals.add(tileId);
    if (typeof window !== "undefined") {
      const w = window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> };
      if (!w.__WS_INVOKE_LOG__) w.__WS_INVOKE_LOG__ = [];
      w.__WS_INVOKE_LOG__.push({
        cmd: "spawn_copilot_session",
        args: { tileId, cwd, resumeSessionId: resumeSessionId ?? null, rows: rows ?? null, cols: cols ?? null, command: command ?? null },
      });
    }
    return null;
  }

  async writeToTerminal(tileId: string, _data: string): Promise<void> {
    if (!this.terminals.has(tileId)) throw new Error(`No terminal: ${tileId}`);
  }

  async resizeTerminal(tileId: string, _rows: number, _cols: number): Promise<void> {
    if (!this.terminals.has(tileId)) throw new Error(`No terminal: ${tileId}`);
  }

  async closeTerminal(tileId: string): Promise<void> {
    this.terminals.delete(tileId);
  }

  async saveScrollback(tileId: string, data: string): Promise<void> {
    this.scrollbacks.set(tileId, data);
  }

  async loadScrollback(tileId: string): Promise<string | null> {
    return this.scrollbacks.get(tileId) ?? null;
  }

  async watchSession(_tileId: string, _sessionName: string): Promise<void> {
    // no-op in memory backend
  }

  async unwatchSession(_tileId: string): Promise<void> {
    // no-op in memory backend
  }

  async searchFiles(_directory: string, query: string): Promise<string[]> {
    // Search seeded files by filename match
    const q = query.toLowerCase();
    return Array.from(this.files.keys()).filter((path) => {
      const name = path.split("/").pop() || path;
      return name.toLowerCase().includes(q);
    });
  }

  async searchInFiles(_directory: string, query: string, limit?: number, options?: import("./types").ContentSearchOptions): Promise<import("./types").FileSearchMatch[]> {
    if (!query.trim()) return [];
    const max = limit ?? 200;
    // Mirror the Rust engine's per-file cap so the in-memory stub behaves the
    // same (kept in sync via the shared CONTENT_SEARCH_MAX_PER_FILE constant).
    const maxPerFile = CONTENT_SEARCH_MAX_PER_FILE;
    const results: import("./types").FileSearchMatch[] = [];
    // Build a matcher mirroring the Rust engine: literal substring by default,
    // optional regex, case-insensitive unless caseSensitive is set.
    const flags = options?.caseSensitive ? "" : "i";
    let test: (line: string) => boolean;
    if (options?.regex) {
      let re: RegExp;
      try {
        re = new RegExp(query, flags);
      } catch {
        return [];
      }
      test = (line) => re.test(line);
    } else if (options?.caseSensitive) {
      test = (line) => line.includes(query);
    } else {
      const q = query.toLowerCase();
      test = (line) => line.toLowerCase().includes(q);
    }
    for (const [path, content] of this.files.entries()) {
      if (results.length >= max) break;
      const lines = content.split("\n");
      let perFile = 0;
      for (let i = 0; i < lines.length; i++) {
        if (test(lines[i])) {
          results.push({ path, line_number: i + 1, line_text: lines[i].slice(0, 240) });
          perFile++;
          if (perFile >= maxPerFile || results.length >= max) break;
        }
      }
    }
    return results;
  }

  async cancelSearches(): Promise<void> {
    // No-op for memory backend; nothing to cancel.
  }

  async gitDiffFiles(_directory: string, _mode: string): Promise<string[]> {
    return [];
  }

  async gitDiffFile(_directory: string, _filePath: string, _mode: string): Promise<string> {
    return "";
  }

  async gitDiffFilesWithStatus(_directory: string, _mode: string): Promise<Array<{ path: string; status: "A" | "M" | "D" | "R" }>> {
    return [];
  }

  async gitDiffFileSides(_directory: string, _filePath: string, _mode: string): Promise<{ before: string; after: string }> {
    return { before: "", after: "" };
  }

  async gitLog(_directory: string, _limit?: number): Promise<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>> {
    return [
      { hash: "abc1234567890", short_hash: "abc1234", message: "Initial commit", author: "Dev", date: "2 days ago" },
      { hash: "def4567890123", short_hash: "def4567", message: "Add feature", author: "Dev", date: "1 day ago" },
    ];
  }

  async gitShowCommit(_directory: string, _hash: string): Promise<string> {
    return "commit abc1234567890\nAuthor: Dev <dev@example.com>\nDate: 2 days ago\n\n    Initial commit\n";
  }

  async gitCurrentBranch(_directory: string): Promise<string> {
    return "main";
  }

  async gitBranchTrackingInfo(_directory: string): Promise<{ ahead: number; behind: number; remoteHeadShort: string }> {
    return { ahead: 0, behind: 0, remoteHeadShort: "" };
  }

  async discoverCopilotConfig(_workstreamDir?: string): Promise<CopilotConfigItem[]> {
    return [];
  }

  async listSessionPlans(_sessionId: string): Promise<import("./types").SessionPlanEntry[]> {
    return [];
  }

  async getCurrentSessionPlan(_sessionId: string): Promise<string | null> {
    return null;
  }

  async listSessionTodoDeps(_sessionId: string): Promise<import("./types").SessionTodoDep[]> {
    return [];
  }

  async listSessionTodos(_sessionId: string): Promise<import("./types").SessionTodo[]> {
    return [];
  }

  async listSessionFeatures(sessionId: string): Promise<import("./types").SessionFeaturesPayload> {
    return this.sessionFeatures.get(sessionId) ?? { features: [], currentPlanId: null };
  }

  async completeSessionPlan(sessionId: string, planId: string): Promise<void> {
    // Reflect the completion in any seeded payload so the tile re-render
    // shows the new state in component tests.
    const payload = this.sessionFeatures.get(sessionId);
    if (!payload) return;
    this.sessionFeatures.set(sessionId, {
      currentPlanId: payload.currentPlanId === planId ? null : payload.currentPlanId,
      features: payload.features.map((f) =>
        f.planId === planId
          ? { ...f, planStatus: "completed", derivedStatus: "completed" as const }
          : f,
      ),
    });
  }

  async watchSessionFeatures(_sessionId: string): Promise<void> {
    // No-op: in-memory backend doesn't emit events.
  }

  async unwatchSessionFeatures(_sessionId: string): Promise<void> {
    // No-op.
  }

  async listFileComments(workstreamId: string, absolutePath: string): Promise<FileComment[]> {
    const all = Array.from(this.fileComments.values()).filter(
      (c) => c.workstream_id === workstreamId && c.absolute_path === absolutePath,
    );
    all.sort((a, b) => {
      if (a.anchor_line_start !== b.anchor_line_start) {
        return a.anchor_line_start - b.anchor_line_start;
      }
      return a.created_at.localeCompare(b.created_at);
    });
    return all;
  }

  async addFileComment(
    workstreamId: string,
    absolutePath: string,
    anchorLineStart: number,
    anchorLineEnd: number,
    anchorText: string | null,
    bodyMd: string,
  ): Promise<FileComment> {
    if (anchorLineEnd < anchorLineStart) {
      throw new Error("anchor_line_end must be >= anchor_line_start");
    }
    const ts = now();
    const comment: FileComment = {
      id: generateId(),
      workstream_id: workstreamId,
      absolute_path: absolutePath,
      anchor_line_start: anchorLineStart,
      anchor_line_end: anchorLineEnd,
      anchor_text: anchorText,
      body_md: bodyMd,
      author: "me",
      origin_type: "user",
      origin_pr_id: null,
      origin_comment_id: null,
      origin_thread_id: null,
      origin_parent_id: null,
      origin_url: null,
      status: null,
      created_at: ts,
      updated_at: ts,
    };
    this.fileComments.set(comment.id, comment);
    return comment;
  }

  async updateFileComment(id: string, bodyMd: string): Promise<FileComment> {
    const existing = this.fileComments.get(id);
    if (!existing) {
      throw new Error(`comment ${id} not found or not editable (imported comments are read-only)`);
    }
    if (existing.origin_type !== "user") {
      throw new Error(`comment ${id} not found or not editable (imported comments are read-only)`);
    }
    const updated: FileComment = { ...existing, body_md: bodyMd, updated_at: now() };
    this.fileComments.set(id, updated);
    return updated;
  }

  async deleteFileComment(id: string): Promise<void> {
    const existing = this.fileComments.get(id);
    if (!existing || existing.origin_type !== "user") {
      throw new Error(`comment ${id} not found or not deletable (imported comments are read-only)`);
    }
    this.fileComments.delete(id);
  }

  async importPrComments(
    workstreamId: string,
    items: ImportedCommentInput[],
  ): Promise<ImportSummary> {
    let inserted = 0;
    let skipped = 0;
    const ts = now();
    for (const item of items) {
      if (item.anchor_line_end < item.anchor_line_start) {
        throw new Error(
          `invalid anchor for ${item.absolute_path}:${item.anchor_line_start}-${item.anchor_line_end} (end < start)`,
        );
      }
      const dup = Array.from(this.fileComments.values()).some(
        (c) =>
          c.origin_type === "ado-pr" &&
          c.origin_pr_id === item.origin_pr_id &&
          c.origin_comment_id === item.origin_comment_id,
      );
      if (dup) {
        skipped += 1;
        continue;
      }
      const comment: FileComment = {
        id: generateId(),
        workstream_id: workstreamId,
        absolute_path: item.absolute_path,
        anchor_line_start: item.anchor_line_start,
        anchor_line_end: item.anchor_line_end,
        anchor_text: item.anchor_text ?? null,
        body_md: item.body_md,
        author: item.author,
        origin_type: "ado-pr",
        origin_pr_id: item.origin_pr_id,
        origin_comment_id: item.origin_comment_id,
        origin_thread_id: item.origin_thread_id ?? null,
        origin_parent_id: item.origin_parent_id ?? null,
        origin_url: item.origin_url ?? null,
        status: item.status ?? null,
        created_at: ts,
        updated_at: ts,
      };
      this.fileComments.set(comment.id, comment);
      inserted += 1;
    }
    return { inserted, skipped };
  }

  // ── Code Review (ADR 014) — offline stub of the reviewer↔agent loop ──────
  // Seeds for tests/dev: bound session, the diff's changed files, and per-file
  // before/after sides. simulateAgentReply lets tests exercise the poll path.

  seedBoundSession(workstreamId: string, sessionId: string | null): void {
    this.boundSessions.set(workstreamId, sessionId);
  }

  seedReviewDiff(files: ChangedFile[]): void {
    this.reviewChangedFiles = files;
  }

  seedReviewDiffSides(file: string, sides: DiffSides): void {
    this.reviewDiffSides.set(file, sides);
  }

  simulateAgentReply(reviewId: string, parentId: string, body: string): ReviewComment {
    const parent = this.reviewComments.get(parentId);
    const ts = now();
    const reply: ReviewComment = {
      id: generateId(),
      review_id: reviewId,
      file: parent?.file ?? "",
      line: parent?.line ?? 0,
      side: parent?.side ?? "new",
      code: null,
      hunk_header: null,
      body,
      author: "agent",
      parent_id: parentId,
      status: "open",
      created_at: ts,
      updated_at: ts,
    };
    this.reviewComments.set(reply.id, reply);
    if (parent) {
      parent.status = "addressed";
      parent.updated_at = ts;
      this.reviewComments.set(parent.id, parent);
    }
    return reply;
  }

  async resolveWorkstreamSession(workstreamId: string): Promise<string | null> {
    if (this.boundSessions.has(workstreamId)) return this.boundSessions.get(workstreamId) ?? null;
    return `mem-session-${workstreamId}`;
  }

  async codeReviewDiffFiles(_directory: string, _diffSource: string, _baseRef?: string | null): Promise<ChangedFile[]> {
    return [...this.reviewChangedFiles];
  }

  async codeReviewDiffFileSides(
    _directory: string,
    filePath: string,
    _diffSource: string,
    _baseRef?: string | null,
  ): Promise<DiffSides> {
    return this.reviewDiffSides.get(filePath) ?? { before: "", after: "" };
  }

  async createReview(
    workstreamId: string,
    diffSource: string,
    baseRef?: string | null,
    title?: string | null,
  ): Promise<Review> {
    const session = await this.resolveWorkstreamSession(workstreamId);
    if (!session) throw new Error("no Copilot session linked to this workstream");
    const ts = now();
    const review: Review = {
      id: generateId(),
      workstream_id: workstreamId,
      diff_source: diffSource,
      base_ref: baseRef ?? null,
      title: title ?? null,
      status: "open",
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    };
    this.reviews.set(review.id, review);
    return review;
  }

  // Sort newest-first, breaking created_at ties by Map insertion order so
  // same-millisecond creations remain deterministic (mirrors the DB rowid tiebreak).
  private reviewsNewestFirst(workstreamId: string): Review[] {
    const order = Array.from(this.reviews.keys());
    return Array.from(this.reviews.values())
      .filter((r) => r.workstream_id === workstreamId)
      .sort(
        (a, b) => b.created_at.localeCompare(a.created_at) || order.indexOf(b.id) - order.indexOf(a.id),
      );
  }

  async getActiveReview(workstreamId: string): Promise<Review | null> {
    return this.reviewsNewestFirst(workstreamId)[0] ?? null;
  }

  async listReviews(workstreamId: string): Promise<Review[]> {
    return this.reviewsNewestFirst(workstreamId);
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
    const ts = now();
    const comment: ReviewComment = {
      id: generateId(),
      review_id: reviewId,
      file,
      line,
      side,
      code: code ?? null,
      hunk_header: hunkHeader ?? null,
      body,
      author: "reviewer",
      parent_id: null,
      status: "open",
      created_at: ts,
      updated_at: ts,
    };
    this.reviewComments.set(comment.id, comment);
    return comment;
  }

  async listReviewComments(_workstreamId: string, reviewId: string): Promise<ReviewComment[]> {
    const rows = Array.from(this.reviewComments.values()).filter((c) => c.review_id === reviewId);
    rows.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      if (a.line !== b.line) return a.line - b.line;
      return a.created_at.localeCompare(b.created_at);
    });
    return rows;
  }

  async setReviewCommentStatus(_workstreamId: string, commentId: string, status: string): Promise<void> {
    const allowed = ["open", "addressed", "resolved", "wontfix"];
    if (!allowed.includes(status)) throw new Error(`invalid status '${status}'`);
    const c = this.reviewComments.get(commentId);
    if (!c || c.parent_id !== null) throw new Error(`review comment ${commentId} not found`);
    c.status = status;
    c.updated_at = now();
    this.reviewComments.set(commentId, c);
  }

  async completeCodeReview(_workstreamId: string, reviewId: string): Promise<void> {
    const r = this.reviews.get(reviewId);
    if (!r) throw new Error(`review ${reviewId} not found`);
    r.status = "completed";
    r.completed_at = now();
    r.updated_at = r.completed_at;
    this.reviews.set(reviewId, r);
  }
}
