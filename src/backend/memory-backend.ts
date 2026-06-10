import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";
import type {
  ChunkInput,
  ChunkWithDetails,
  DiffChunk,
  DiffComment,
  DiffHunk,
  DiffReview,
  DiffSource,
} from "../domain/diff-review";
import type { FileComment, ImportedCommentInput, ImportSummary } from "../domain/file-comments";
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
  private terminals = new Set<string>();
  private diffReviews = new Map<string, DiffReview>();
  private diffChunks = new Map<string, DiffChunk>();
  private diffHunks = new Map<string, DiffHunk[]>();
  private diffComments = new Map<string, DiffComment[]>();
  private invalidatedChunks = new Map<string, Set<string>>();
  private fileComments = new Map<string, FileComment>();

  seedFile(path: string, content: string): void {
    this.files.set(path, content);
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
    opts: { directory?: string; branchName?: string; folderName?: string }
  ): Promise<{ workstream: Workstream; affectedTileIds: string[] }> {
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

  async searchInFiles(_directory: string, query: string, limit?: number): Promise<import("./types").FileSearchMatch[]> {
    const q = query.toLowerCase();
    if (!q.trim()) return [];
    const max = limit ?? 200;
    const maxPerFile = 5;
    const results: import("./types").FileSearchMatch[] = [];
    for (const [path, content] of this.files.entries()) {
      if (results.length >= max) break;
      const lines = content.split("\n");
      let perFile = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
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

  // --- Diff Review (ADR 007) ---

  /**
   * Test/dev seeding helper — pre-populate a review with chunks, hunks, and
   * optionally comments. Mirrors the shape the real backend exposes.
   */
  seedDiffReview(input: {
    review: DiffReview;
    chunks: DiffChunk[];
    hunks: DiffHunk[];
    comments?: DiffComment[];
  }): void {
    this.diffReviews.set(input.review.id, input.review);
    for (const chunk of input.chunks) {
      this.diffChunks.set(chunk.id, chunk);
      this.diffHunks.set(chunk.id, []);
      this.diffComments.set(chunk.id, []);
    }
    for (const hunk of input.hunks) {
      const arr = this.diffHunks.get(hunk.chunk_id) ?? [];
      arr.push(hunk);
      this.diffHunks.set(hunk.chunk_id, arr);
    }
    for (const comment of input.comments ?? []) {
      const arr = this.diffComments.get(comment.chunk_id) ?? [];
      arr.push(comment);
      this.diffComments.set(comment.chunk_id, arr);
    }
  }

  /** Test helper: mark a set of chunks invalidated so the next detectDrift returns them. */
  seedDiffDrift(reviewId: string, chunkIds: string[]): void {
    this.invalidatedChunks.set(reviewId, new Set(chunkIds));
  }

  async listActiveDiffReviews(workstreamId: string): Promise<DiffReview[]> {
    return Array.from(this.diffReviews.values())
      .filter((review) => review.workstream_id === workstreamId && review.status === "active")
      .sort((a, b) => {
        const createdCompare = b.created_at.localeCompare(a.created_at);
        return createdCompare !== 0 ? createdCompare : a.id.localeCompare(b.id);
      });
  }

  private getDiffReviewIdFromTile(tile: Tile): string | null {
    try {
      const config = JSON.parse(tile.config_json) as { reviewId?: unknown };
      return typeof config.reviewId === "string" ? config.reviewId : null;
    } catch {
      return null;
    }
  }

  async createOrFocusDiffReviewTile(workstreamId: string, reviewId: string): Promise<Tile> {
    for (const tile of this.tiles.values()) {
      if (
        tile.workstream_id === workstreamId &&
        tile.tile_type === "diff_review" &&
        this.getDiffReviewIdFromTile(tile) === reviewId
      ) {
        return tile;
      }
    }

    const timestamp = now();
    const tile: Tile = {
      id: generateId(),
      workstream_id: workstreamId,
      tile_type: "diff_review",
      title: `Review: ${reviewId.slice(0, 8)}`,
      config_json: JSON.stringify({ reviewId }),
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.tiles.set(tile.id, tile);

    const layout = await this.getLayout(workstreamId);
    let tileOrder: string[];
    try {
      const parsed = JSON.parse(layout.tile_order_json) as unknown;
      tileOrder = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      tileOrder = [];
    }
    if (!tileOrder.includes(tile.id)) {
      tileOrder.push(tile.id);
    }
    await this.updateLayout(workstreamId, { tile_order_json: JSON.stringify(tileOrder) });

    return tile;
  }

  async createDiffReview(workstreamId: string, diffSource: DiffSource, sourceRef: string | null): Promise<DiffReview> {
    const review: DiffReview = {
      id: generateId(),
      workstream_id: workstreamId,
      diff_source: diffSource,
      source_ref: sourceRef,
      status: "planning",
      plan_json: null,
      exported_path: null,
      created_at: now(),
      updated_at: now(),
      completed_at: null,
    };
    this.diffReviews.set(review.id, review);
    return review;
  }

  async setReviewPlan(reviewId: string, planJson: string, chunks: ChunkInput[] = []): Promise<void> {
    const review = this.diffReviews.get(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    review.plan_json = planJson;
    review.status = "active";
    review.updated_at = now();
    chunks.forEach((input, idx) => {
      const chunkId = generateId();
      const chunk: DiffChunk = {
        id: chunkId,
        review_id: reviewId,
        ordinal: idx,
        title: input.title,
        summary: input.summary,
        is_trivial: input.is_trivial,
        state: "pending",
        question_text: input.question_text,
        question_style: input.question_style,
        invalidated_at: null,
        created_at: now(),
        updated_at: now(),
      };
      this.diffChunks.set(chunkId, chunk);
      const hunks: DiffHunk[] = input.hunks.map((h) => ({
        id: generateId(),
        chunk_id: chunkId,
        file_path: h.file_path,
        old_start: h.old_start,
        old_lines: h.old_lines,
        new_start: h.new_start,
        new_lines: h.new_lines,
        patch_text: h.patch_text,
        content_hash: `mem-${chunkId}-${h.file_path}`,
      }));
      this.diffHunks.set(chunkId, hunks);
    });
  }

  async getReview(reviewId: string): Promise<DiffReview> {
    const review = this.diffReviews.get(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    return review;
  }

  async listChunks(reviewId: string): Promise<DiffChunk[]> {
    return Array.from(this.diffChunks.values())
      .filter((c) => c.review_id === reviewId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async getChunkDetails(chunkId: string): Promise<ChunkWithDetails> {
    const chunk = this.diffChunks.get(chunkId);
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);
    return {
      chunk,
      hunks: this.diffHunks.get(chunkId) ?? [],
      comments: this.diffComments.get(chunkId) ?? [],
    };
  }

  async activateChunk(_reviewId: string, chunkId: string): Promise<void> {
    const chunk = this.diffChunks.get(chunkId);
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);
    if (chunk.state === "pending") {
      chunk.state = "seen";
    }
    chunk.updated_at = now();
  }

  async ackChunk(chunkId: string, state: "approved" | "commented" | "seen"): Promise<void> {
    const chunk = this.diffChunks.get(chunkId);
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);
    chunk.state = state;
    chunk.updated_at = now();
  }

  async addComment(chunkId: string, anchorFile: string, anchorLineStart: number, anchorLineEnd: number, text: string): Promise<DiffComment> {
    const chunk = this.diffChunks.get(chunkId);
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);
    const comment: DiffComment = {
      id: generateId(),
      chunk_id: chunkId,
      anchor_file: anchorFile,
      anchor_line_start: anchorLineStart,
      anchor_line_end: anchorLineEnd,
      text,
      created_at: now(),
    };
    const arr = this.diffComments.get(chunkId) ?? [];
    arr.push(comment);
    this.diffComments.set(chunkId, arr);
    if (chunk.state !== "commented") {
      chunk.state = "commented";
      chunk.updated_at = now();
    }
    return comment;
  }

  async completeReview(reviewId: string): Promise<{ exported_path: string }> {
    const review = this.diffReviews.get(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    const exportedPath = `.copilot-reviews/${reviewId}/review.json`;
    review.status = "completed";
    review.completed_at = now();
    review.exported_path = exportedPath;
    review.updated_at = now();
    return { exported_path: exportedPath };
  }

  async detectDrift(reviewId: string): Promise<string[]> {
    const set = this.invalidatedChunks.get(reviewId);
    return set ? Array.from(set) : [];
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
}
