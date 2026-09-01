import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";
import type { SessionFileComment } from "../domain/file-comments";
import type { Review, ReviewComment, ChangedFile, DiffSides } from "../domain/code-review";
import { CONTENT_SEARCH_MAX_PER_FILE } from "../domain/content-search";
import { compareByCreatedAt } from "../domain/comment-order";
import type {
  Backend,
  CodeTrace,
  TraceStaleness,
  TaskUpdate,
  DevlogExportResult,
} from "./types";
import type {
  Task,
  Subtask,
  Label,
  TaskEvent,
  TaskEventKind,
  TaskEventSource,
} from "../domain/tasks";
import { makeTask, makeEvent, sortEvents } from "../domain/tasks";
import type { TaskStatus } from "../domain/task-status";
import { isTerminalStatus } from "../domain/task-status";
import { resolveLabelNames } from "../domain/task-labels";
import { isGeneratedByUs } from "../domain/devlog-render";
import { parseTraceFile, type TraceFile } from "../domain/trace-format";
import { rewriteTileCwd } from "../domain/worktree-change";
import { projectOwningPath } from "../domain/worktree-path";
import {
  transitionLoop,
  type LoopObservedOutcome,
  type LoopRun,
  type LoopDefinition,
  type LoopDefinitionCatalog,
  type LoopSnapshot,
  type LoopSpec,
  type LoopSpecDraft,
  type LoopSummary,
  type LoopTask,
  type PersistedLoopSnapshot,
} from "../domain/loop";

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
  private loopSpecs = new Map<string, LoopSpec>();
  private loopSnapshots = new Map<string, PersistedLoopSnapshot>();
  private loopRunWorkstreams = new Map<string, string>();
  private loopTimers = new Map<string, Array<ReturnType<typeof setTimeout>>>();
  private loopApprovalDecisions = new Set<string>();
  private loopDefinitions = new Map<
    string,
    { definition: LoopDefinition; spec: LoopSpecDraft; workstreamId?: string }
  >();

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

  seedLoopDefinition(
    definition: LoopDefinition,
    spec: LoopSpecDraft,
    workstreamId?: string,
  ): void {
    this.loopDefinitions.set(definition.path, { definition, spec, workstreamId });
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
      copilot_command: null,
      created_at: now(),
      updated_at: now(),
    };
    this.projects.set(p.id, p);
    return p;
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<void> {
    const p = this.projects.get(id);
    if (!p) throw new Error(`Project not found: ${id}`);
    // Mirror the Rust update_project override semantics: an empty/whitespace
    // copilot_command clears the override (null = inherit global).
    const patch: Partial<Project> = { ...updates };
    if (typeof patch.copilot_command === "string") {
      const trimmed = patch.copilot_command.trim();
      patch.copilot_command = trimmed.length > 0 ? trimmed : null;
    }
    Object.assign(p, patch, { updated_at: now() });
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
    let newProjectId: string | null = null;
    if (mode === "switch_existing") {
      if (!opts.directory) throw new Error("Directory is required");
      finalDir = opts.directory;

      // The chosen directory may belong to a different repo -- switching repo
      // is the same gesture as switching worktree. The real backend resolves
      // this from git; here it is path containment, which is the same shape.
      const owner = projectOwningPath([...this.projects.values()], finalDir);
      if (owner) {
        newProjectId = owner.id;
      } else if (ws.project_id) {
        // Refuse rather than importing: a mistyped path would otherwise become
        // a stray project. Only when there is a binding to lose, though --
        // a workstream created without a repo could always switch freely, and
        // blocking that would be a regression unrelated to changing repo.
        throw new Error(
          `${finalDir} is not part of any repo Workstreams knows about — import the repo first, then switch to it`,
        );
      }
    } else {
      if (!opts.branchName) throw new Error("Branch name is required");
      finalDir = pathJoin(parentDirectory(ws.directory ?? ""), opts.folderName || lastSlashSegment(opts.branchName));
      finalBranch = opts.branchName;
    }

    Object.assign(ws, {
      directory: finalDir,
      worktree_branch: finalBranch,
      updated_at: now(),
      // create_new branches from the workstream's own repo, so it never moves.
      ...(newProjectId ? { project_id: newProjectId } : {}),
    });

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

  async getWorkstreamLoopSnapshot(
    workstreamId: string,
  ): Promise<PersistedLoopSnapshot> {
    return this.loopSnapshots.get(workstreamId) ?? {
      spec: this.loopSpecs.get(workstreamId) ?? null,
      latestRun: null,
      tasks: [],
      verifications: [],
      evaluations: [],
      approvals: [],
      events: [],
    };
  }

  async getWorkstreamLoopProgressVersion(workstreamId: string): Promise<string> {
    const snapshot = await this.getWorkstreamLoopSnapshot(workstreamId);
    return JSON.stringify({
      spec: snapshot.spec?.updatedAt ?? null,
      run: snapshot.latestRun
        ? {
            id: snapshot.latestRun.id,
            state: snapshot.latestRun.state,
            control: snapshot.latestRun.controlRequested,
          }
        : null,
      tasks: snapshot.tasks.map((task) => [
        task.id,
        task.state,
        task.revisionCount,
        task.updatedAt,
      ]),
      verifications: snapshot.verifications.length,
      evaluations: snapshot.evaluations.length,
      events: snapshot.events.length,
    });
  }

  async listLoopDefinitions(workstreamId: string): Promise<LoopDefinitionCatalog> {
    return {
      definitions: [...this.loopDefinitions.values()]
        .filter((entry) => !entry.workstreamId || entry.workstreamId === workstreamId)
        .map(({ definition }) => definition)
        .sort((left, right) => left.path.localeCompare(right.path)),
      invalid: [],
    };
  }

  async saveWorkstreamLoop(
    workstreamId: string,
    input: LoopSpecDraft,
  ): Promise<LoopSpec> {
    const existing = this.loopSpecs.get(workstreamId);
    if (existing?.enabled) {
      throw new Error("Disable the loop before changing its configuration");
    }
    const timestamp = now();
    const spec: LoopSpec = {
      ...input,
      id: existing?.id ?? generateId(),
      workstreamId,
      enabled: false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.loopSpecs.set(workstreamId, spec);
    this.loopSnapshots.set(workstreamId, {
      spec,
      latestRun: this.loopSnapshots.get(workstreamId)?.latestRun ?? null,
      tasks: this.loopSnapshots.get(workstreamId)?.tasks ?? [],
      verifications: this.loopSnapshots.get(workstreamId)?.verifications ?? [],
      evaluations: this.loopSnapshots.get(workstreamId)?.evaluations ?? [],
      approvals: this.loopSnapshots.get(workstreamId)?.approvals ?? [],
      events: this.loopSnapshots.get(workstreamId)?.events ?? [],
    });
    this.emitLoopUpdate(workstreamId);
    return spec;
  }

  async setWorkstreamLoopEnabled(
    loopSpecId: string,
    enabled: boolean,
  ): Promise<void> {
    const entry = [...this.loopSpecs.entries()].find(([, spec]) => spec.id === loopSpecId);
    if (!entry) throw new Error(`Loop specification not found: ${loopSpecId}`);
    const [workstreamId, spec] = entry;
    const updated = { ...spec, enabled, updatedAt: now() };
    this.loopSpecs.set(workstreamId, updated);
    const snapshot = await this.getWorkstreamLoopSnapshot(workstreamId);
    this.loopSnapshots.set(workstreamId, { ...snapshot, spec: updated });
    this.emitLoopUpdate(workstreamId);
  }

  async listWorkstreamLoopSummaries(): Promise<LoopSummary[]> {
    return [...this.loopSpecs.entries()].map(([workstreamId, spec]) => {
      const run = this.loopSnapshots.get(workstreamId)?.latestRun;
      return {
        workstreamId,
        loopSpecId: spec.id,
        enabled: spec.enabled,
        runId: run?.id,
        runState: run?.state,
        controlRequested: run?.controlRequested,
        currentTaskId: run?.activeTaskId ?? undefined,
        startedAt: run?.startedAt,
      };
    });
  }

  async runWorkstreamLoopNow(workstreamId: string): Promise<LoopRun> {
    const spec = this.loopSpecs.get(workstreamId);
    if (!spec) throw new Error("Configure this workstream's loop first");
    if (!spec.enabled) throw new Error("Enable the loop before starting it");
    const active = this.loopSnapshots.get(workstreamId)?.latestRun;
    if (
      active &&
      !["completed", "attention", "killed"].includes(active.state)
    ) {
      throw new Error("This loop already has an active run");
    }

    const timestamp = now();
    const run: LoopRun = {
      id: generateId(),
      loopSpecId: spec.id,
      state: "starting",
      activeTaskId: null,
      pauseRequested: false,
      stopRequested: false,
      pendingAction: null,
      controlRequested: "none",
      startedAt: timestamp,
      deadlineAt: new Date(Date.now() + spec.runTimeoutMs).toISOString(),
    };
    this.loopRunWorkstreams.set(run.id, workstreamId);
    const initial: PersistedLoopSnapshot = {
      spec,
      latestRun: run,
      tasks: [],
      verifications: [],
      evaluations: [],
      approvals: [],
      events: [{
        id: 1,
        loopSpecId: spec.id,
        loopRunId: run.id,
        eventType: "run.started",
        payload: {},
        createdAt: timestamp,
      }],
    };
    this.loopSnapshots.set(
      workstreamId,
      this.applyMemoryOutcome(initial, { type: "run_started" }),
    );
    this.scheduleMemoryLoop(workstreamId, run.id);
    this.emitLoopUpdate(workstreamId);
    return run;
  }

  async runLoopDefinitionNow(
    workstreamId: string,
    definitionPath: string,
  ): Promise<LoopRun> {
    const entry = this.loopDefinitions.get(definitionPath);
    if (!entry) throw new Error(`Loop definition not found: ${definitionPath}`);
    const existing = this.loopSpecs.get(workstreamId);
    if (existing?.enabled) {
      await this.setWorkstreamLoopEnabled(existing.id, false);
    }
    const saved = await this.saveWorkstreamLoop(workstreamId, entry.spec);
    const bound: LoopSpec = {
      ...saved,
      enabled: true,
      definitionId: entry.definition.id,
      definitionPath: entry.definition.path,
      definitionHash: entry.definition.hash,
      definitionName: entry.definition.name,
      objective: entry.definition.objective,
      portable: entry.definition.portable,
    };
    this.loopSpecs.set(workstreamId, bound);
    const snapshot = await this.getWorkstreamLoopSnapshot(workstreamId);
    this.loopSnapshots.set(workstreamId, { ...snapshot, spec: bound });
    return this.runWorkstreamLoopNow(workstreamId);
  }

  async decideLoopHumanApproval(
    runId: string,
    decision: "approve" | "revise" | "reject",
    feedback?: string,
  ): Promise<LoopRun> {
    if (this.loopApprovalDecisions.has(runId)) {
      throw new Error("Human approval is already being decided");
    }
    this.loopApprovalDecisions.add(runId);
    try {
      const workstreamId = this.loopRunWorkstreams.get(runId);
      if (!workstreamId) throw new Error(`Loop run not found: ${runId}`);
      const snapshot = await this.getWorkstreamLoopSnapshot(workstreamId);
      if (
        snapshot.latestRun?.id !== runId ||
        snapshot.latestRun.state !== "awaiting_approval" ||
        !snapshot.latestRun.activeTaskId
      ) {
        throw new Error("This loop run is not awaiting human approval");
      }
      const pending = [...snapshot.approvals]
        .reverse()
        .find(
          (approval) =>
            approval.status === "pending" &&
            approval.loopTaskId === snapshot.latestRun?.activeTaskId,
        );
      if (!pending) throw new Error("Pending human approval was not found");
      const trimmedFeedback = feedback?.trim();
      if (decision === "revise" && !trimmedFeedback) {
        throw new Error("Revision feedback is required");
      }
      const decidedAt = now();
      const next = this.applyMemoryOutcome(snapshot, {
        type: "approval_decided",
        decision,
      });
      const updated: PersistedLoopSnapshot = {
        ...next,
        latestRun: next.latestRun
          ? {
              ...next.latestRun,
              finishedAt: decision === "reject" ? decidedAt : undefined,
            }
          : null,
        approvals: snapshot.approvals.map((approval) =>
          approval.id === pending.id
            ? {
                ...approval,
                status:
                  decision === "approve"
                    ? "approved"
                    : decision === "revise"
                      ? "revision_requested"
                      : "rejected",
                feedback: trimmedFeedback,
                decidedAt,
              }
            : approval,
        ),
      };
      this.loopSnapshots.set(workstreamId, updated);
      if (
        decision === "revise" ||
        (updated.latestRun &&
          !["completed", "attention", "killed"].includes(updated.latestRun.state))
      ) {
        this.scheduleMemoryLoop(workstreamId, runId);
      } else {
        this.clearLoopTimers(runId);
      }
      this.emitLoopUpdate(workstreamId);
      return updated.latestRun!;
    } finally {
      this.loopApprovalDecisions.delete(runId);
    }
  }

  async resumeWorkstreamLoop(runId: string): Promise<LoopRun> {
    const workstreamId = this.loopRunWorkstreams.get(runId);
    if (!workstreamId) throw new Error(`Loop run not found: ${runId}`);
    const snapshot = await this.getWorkstreamLoopSnapshot(workstreamId);
    const run = snapshot.latestRun;
    if (!run || run.state !== "paused") {
      throw new Error("Only a paused loop run can be resumed");
    }
    const resumed = this.applyMemoryOutcome(snapshot, { type: "resume_requested" });
    if (resumed.latestRun?.state === "paused") {
      throw new Error("Paused loop has no pending action to resume");
    }
    const restored = this.addPendingApproval(snapshot, resumed);
    this.loopSnapshots.set(workstreamId, restored);
    this.scheduleMemoryLoop(workstreamId, runId);
    this.emitLoopUpdate(workstreamId);
    return restored.latestRun!;
  }

  async controlWorkstreamLoop(
    runId: string,
    action: "pause" | "stop" | "kill",
  ): Promise<void> {
    const workstreamId = this.loopRunWorkstreams.get(runId);
    if (!workstreamId) throw new Error(`Loop run not found: ${runId}`);
    const snapshot = await this.getWorkstreamLoopSnapshot(workstreamId);
    if (!snapshot.latestRun) throw new Error(`Loop run not found: ${runId}`);
    if (action === "kill") this.clearLoopTimers(runId);
    const outcome: LoopObservedOutcome =
      action === "pause"
        ? { type: "pause_requested" }
        : action === "stop"
          ? { type: "stop_requested" }
          : { type: "kill_requested" };
    const transitioned = this.applyMemoryOutcome(snapshot, outcome);
    const next =
      action === "stop" && snapshot.latestRun.state === "awaiting_approval"
        ? this.applyMemoryOutcome(transitioned, { type: "stop_completed" })
        : transitioned;
    const decidedAt = now();
    this.loopSnapshots.set(workstreamId, {
      ...next,
      latestRun: next.latestRun
        ? {
            ...next.latestRun,
            controlRequested: action,
            finishedAt: action === "kill" ? now() : next.latestRun.finishedAt,
          }
        : null,
      tasks: next.tasks.map((task) =>
        action === "kill" && task.state === "interrupted"
          ? { ...task, error: "Loop killed" }
          : task
      ),
      approvals: next.approvals.map((approval) =>
        approval.status === "pending" && (action === "stop" || action === "kill")
          ? {
              ...approval,
              status: "cancelled",
              feedback: action === "kill" ? "Loop killed" : "Loop stopped",
              decidedAt,
            }
          : approval,
      ),
    });
    this.emitLoopUpdate(workstreamId);
  }

  private emitLoopUpdate(workstreamId: string): void {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("memory-loop-updated", { detail: { workstreamId } }),
      );
    }
  }

  private clearLoopTimers(runId: string): void {
    for (const timer of this.loopTimers.get(runId) ?? []) clearTimeout(timer);
    this.loopTimers.delete(runId);
  }

  private applyMemoryOutcome(
    snapshot: PersistedLoopSnapshot,
    outcome: LoopObservedOutcome,
  ): PersistedLoopSnapshot {
    if (!snapshot.spec || !snapshot.latestRun) return snapshot;
    const domainSnapshot: LoopSnapshot = {
      spec: snapshot.spec,
      run: snapshot.latestRun,
      tasks: snapshot.tasks,
    };
    const transitioned = transitionLoop(domainSnapshot, outcome);
    return {
      ...snapshot,
      latestRun: transitioned.snapshot.run,
      tasks: transitioned.snapshot.tasks,
    };
  }

  private addPendingApproval(
    previous: PersistedLoopSnapshot,
    next: PersistedLoopSnapshot,
  ): PersistedLoopSnapshot {
    if (
      previous.latestRun?.state === "awaiting_approval" ||
      next.latestRun?.state !== "awaiting_approval" ||
      !next.spec?.humanApproval ||
      !next.latestRun.activeTaskId
    ) {
      return next;
    }
    return {
      ...next,
      approvals: [
        ...next.approvals,
        {
          id: generateId(),
          loopTaskId: next.latestRun.activeTaskId,
          attempt:
            (next.tasks.find((task) => task.id === next.latestRun?.activeTaskId)
              ?.revisionCount ?? 0) + 1,
          status: "pending",
          prompt: next.spec.humanApproval.prompt,
          createdAt: now(),
        },
      ],
    };
  }

  private scheduleMemoryLoop(workstreamId: string, runId: string): void {
    this.clearLoopTimers(runId);
    const transition = (
      delay: number,
      update: (snapshot: PersistedLoopSnapshot) => PersistedLoopSnapshot,
    ) =>
      setTimeout(() => {
        const snapshot = this.loopSnapshots.get(workstreamId);
        if (!snapshot || snapshot.latestRun?.id !== runId) return;
        if (["paused", "completed", "killed"].includes(snapshot.latestRun.state)) return;
        const next = update(snapshot);
        this.loopSnapshots.set(workstreamId, this.addPendingApproval(snapshot, next));
        this.emitLoopUpdate(workstreamId);
      }, delay);

    const timers = [
      transition(300, (snapshot) => {
        if (snapshot.latestRun?.state !== "orchestrating") return snapshot;
        if (snapshot.tasks.length > 0) {
          return this.applyMemoryOutcome(snapshot, {
            type: "orchestration_completed",
          });
        }
        const task: LoopTask = snapshot.tasks[0] ?? {
          id: generateId(),
          loopRunId: runId,
          loopSpecId: snapshot.spec?.id ?? "",
          key: "memory-coding-task",
          title: "Implement the coding objective",
          objective: "Complete the configured coding objective.",
          state: "working",
          workerSessionId: "memory-worker-session",
          revisionCount: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        return this.applyMemoryOutcome(
          { ...snapshot, tasks: snapshot.tasks.length > 0 ? snapshot.tasks : [] },
          { type: "tasks_proposed", tasks: [{ ...task, state: "queued" }] },
        );
      }),
      transition(650, (snapshot) => {
        if (snapshot.latestRun?.state !== "working") return snapshot;
        const transitioned = this.applyMemoryOutcome(snapshot, {
          type: "worker_completed",
          workerSessionId: "memory-worker-session",
        });
        return {
          ...transitioned,
          tasks: transitioned.tasks.map((task) => ({
          ...task,
          workerResult: JSON.stringify({
            status: "completed",
            summary: "Implemented the configured objective",
            evidence: ["memory fixture"],
          }),
        })),
        };
      }),
      transition(1_000, (snapshot) => {
        const transitioned =
          snapshot.latestRun?.state === "verifying"
            ? this.applyMemoryOutcome(snapshot, {
                type: "verification_completed",
                result: { kind: "passed" },
              })
            : snapshot;
        return {
          ...transitioned,
          verifications:
            snapshot.spec?.verifier && snapshot.tasks[0]
              ? [
                  ...snapshot.verifications,
                  {
                    id: generateId(),
                    loopTaskId: snapshot.tasks[0].id,
                    attempt: snapshot.tasks[0].revisionCount + 1,
                    status: "passed",
                    program: snapshot.spec.verifier.program,
                    args: [...snapshot.spec.verifier.args],
                    cwd: snapshot.spec.verifier.cwd,
                    durationMs: 12,
                    stdout: "Verification passed",
                    stderr: "",
                    truncated: false,
                    createdAt: now(),
                  },
                ]
              : snapshot.verifications,
        };
      }),
      transition(1_450, (snapshot) => {
        const transitioned =
          snapshot.latestRun?.state === "stopping"
            ? this.applyMemoryOutcome(snapshot, { type: "stop_completed" })
            : snapshot.latestRun?.state === "evaluating"
              ? this.applyMemoryOutcome(snapshot, {
                  type: "evaluation_completed",
                  verdict: "accepted",
                })
              : snapshot;
        return {
          ...transitioned,
          latestRun:
            transitioned.latestRun?.state === "completed"
              ? { ...transitioned.latestRun, finishedAt: now() }
              : transitioned.latestRun,
          evaluations:
            snapshot.tasks[0] && snapshot.latestRun?.state === "evaluating"
              ? [
                  ...snapshot.evaluations,
                  {
                    id: generateId(),
                    loopTaskId: snapshot.tasks[0].id,
                    attempt: snapshot.tasks[0].revisionCount + 1,
                    sessionId: "memory-evaluator-session",
                    verdict: "accepted",
                    summary: "The result satisfies the objective.",
                    evidence: ["memory fixture"],
                    createdAt: now(),
                  },
                ]
              : snapshot.evaluations,
        };
      }),
      transition(1_800, (snapshot) => {
        if (snapshot.latestRun?.state !== "orchestrating") return snapshot;
        const transitioned = this.applyMemoryOutcome(snapshot, {
          type: "orchestration_completed",
        });
        return {
          ...transitioned,
          latestRun: transitioned.latestRun
            ? { ...transitioned.latestRun, finishedAt: now() }
            : transitioned.latestRun,
        };
      }),
    ];
    this.loopTimers.set(runId, timers);
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

  async gitDiffFiles(_directory: string, _mode: string, _baseRef?: string | null): Promise<string[]> {
    return [];
  }

  async gitDiffFile(_directory: string, _filePath: string, _mode: string, _baseRef?: string | null): Promise<string> {
    return "";
  }

  async gitDiffFilesWithStatus(_directory: string, _mode: string, _baseRef?: string | null): Promise<Array<{ path: string; status: "A" | "M" | "D" | "R" }>> {
    return [];
  }

  async gitDiffFileSides(_directory: string, _filePath: string, _mode: string, _baseRef?: string | null): Promise<{ before: string; after: string }> {
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

  async gitListBranches(_directory: string): Promise<string[]> {
    return ["main"];
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

  // ── Session.db-backed inline file comments (unify-commenting) ────────────
  // Offline stub mirroring the reviewer↔agent reply/status model. `file` is a
  // repo-relative path. Requires a linked session (throws when unbound).
  private sessionFileComments = new Map<string, SessionFileComment>();

  private requireBoundSession(workstreamId: string): void {
    const sid = this.boundSessions.get(workstreamId);
    if (!sid) {
      throw new Error("No linked Copilot session for this workstream");
    }
  }

  async listSessionFileComments(
    workstreamId: string,
    file: string,
  ): Promise<SessionFileComment[]> {
    this.requireBoundSession(workstreamId);
    const all = Array.from(this.sessionFileComments.values()).filter(
      (c) => c.workstream_id === workstreamId && c.file === file,
    );
    all.sort((a, b) => {
      if (a.anchor_line_start !== b.anchor_line_start) {
        return a.anchor_line_start - b.anchor_line_start;
      }
      return compareByCreatedAt(a, b);
    });
    return all;
  }

  async listAllSessionFileComments(workstreamId: string): Promise<SessionFileComment[]> {
    this.requireBoundSession(workstreamId);
    const all = Array.from(this.sessionFileComments.values()).filter(
      (c) => c.workstream_id === workstreamId,
    );
    // Mirrors the SQL ordering in list_all_file_comments_rows.
    all.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      if (a.anchor_line_start !== b.anchor_line_start) {
        return a.anchor_line_start - b.anchor_line_start;
      }
      return compareByCreatedAt(a, b);
    });
    return all;
  }

  async addSessionFileComment(
    workstreamId: string,
    file: string,
    anchorLineStart: number,
    anchorLineEnd: number,
    anchorText: string | null,
    body: string,
  ): Promise<SessionFileComment> {
    this.requireBoundSession(workstreamId);
    if (anchorLineEnd < anchorLineStart) {
      throw new Error("anchor_line_end must be >= anchor_line_start");
    }
    const ts = now();
    const comment: SessionFileComment = {
      id: generateId(),
      workstream_id: workstreamId,
      file,
      anchor_line_start: anchorLineStart,
      anchor_line_end: anchorLineEnd,
      anchor_text: anchorText,
      body,
      author: "reviewer",
      parent_id: null,
      status: "open",
      created_at: ts,
      updated_at: ts,
    };
    this.sessionFileComments.set(comment.id, comment);
    return comment;
  }

  async replySessionFileComment(
    workstreamId: string,
    parentId: string,
    body: string,
  ): Promise<SessionFileComment> {
    this.requireBoundSession(workstreamId);
    const parent = this.sessionFileComments.get(parentId);
    if (!parent) {
      throw new Error(`comment ${parentId} not found`);
    }
    const ts = now();
    const reply: SessionFileComment = {
      id: generateId(),
      workstream_id: parent.workstream_id,
      file: parent.file,
      anchor_line_start: parent.anchor_line_start,
      anchor_line_end: parent.anchor_line_end,
      anchor_text: parent.anchor_text,
      body,
      author: "reviewer",
      parent_id: parentId,
      status: parent.status,
      created_at: ts,
      updated_at: ts,
    };
    this.sessionFileComments.set(reply.id, reply);
    return reply;
  }

  async updateSessionFileComment(
    workstreamId: string,
    id: string,
    body: string,
  ): Promise<SessionFileComment> {
    this.requireBoundSession(workstreamId);
    const existing = this.sessionFileComments.get(id);
    if (!existing || existing.author !== "reviewer") {
      throw new Error(`comment ${id} not found or not editable`);
    }
    const updated: SessionFileComment = { ...existing, body, updated_at: now() };
    this.sessionFileComments.set(id, updated);
    return updated;
  }

  async setSessionFileCommentStatus(
    workstreamId: string,
    id: string,
    status: string,
  ): Promise<SessionFileComment> {
    this.requireBoundSession(workstreamId);
    const existing = this.sessionFileComments.get(id);
    if (!existing) {
      throw new Error(`comment ${id} not found`);
    }
    const updated: SessionFileComment = { ...existing, status, updated_at: now() };
    this.sessionFileComments.set(id, updated);
    return updated;
  }

  async deleteSessionFileCommentThread(workstreamId: string, id: string): Promise<void> {
    this.requireBoundSession(workstreamId);
    if (!this.sessionFileComments.has(id)) {
      throw new Error(`comment ${id} not found`);
    }
    // Author-agnostic by design; always cascades so no headless reply is left.
    for (const [cid, c] of Array.from(this.sessionFileComments.entries())) {
      if (cid === id || c.parent_id === id) this.sessionFileComments.delete(cid);
    }
  }

  async deleteSessionFileComment(workstreamId: string, id: string): Promise<void> {
    this.requireBoundSession(workstreamId);
    const existing = this.sessionFileComments.get(id);
    if (!existing || existing.author !== "reviewer") {
      throw new Error(`comment ${id} not found or not deletable`);
    }
    // Cascade: remove the reviewer note and its agent replies.
    for (const [cid, c] of Array.from(this.sessionFileComments.entries())) {
      if (cid === id || c.parent_id === id) {
        this.sessionFileComments.delete(cid);
      }
    }
  }

  // ── Code Review (ADR 014) — offline stub of the reviewer↔agent loop ──────
  // Seeds for tests/dev: bound session, the diff's changed files, and per-file
  // before/after sides. simulateAgentReply lets tests exercise the poll path.

  seedBoundSession(workstreamId: string, sessionId: string | null): void {
    this.boundSessions.set(workstreamId, sessionId);
  }

  /**
   * Test/dev seed for a session file comment with an arbitrary author.
   *
   * The write commands only ever author `reviewer`; rows authored by the agent
   * or imported from an external review (the `ado-file-comments` skill stores
   * the ADO reviewer's display name) arrive through raw SQL. This seed lets the
   * offline stub represent those rows so author rendering and reply ordering
   * are exercised without a real session.db.
   */
  seedSessionFileComment(
    comment: Partial<SessionFileComment> & Pick<SessionFileComment, "id" | "workstream_id" | "file">,
  ): SessionFileComment {
    const ts = comment.created_at ?? now();
    const row: SessionFileComment = {
      anchor_line_start: 1,
      anchor_line_end: 1,
      anchor_text: null,
      body: "",
      author: "reviewer",
      parent_id: null,
      status: "open",
      updated_at: ts,
      ...comment,
      created_at: ts,
    };
    this.sessionFileComments.set(row.id, row);
    return row;
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

  // ── Code walkthrough traces ──────────────────────────────────────────
  //
  // Traces are held in memory rather than read from disk, so E2E runs and
  // offline development need neither a debugger nor real recorded files.

  private traceFiles = new Map<string, unknown>();
  private traceIndex = new Map<string, CodeTrace>();

  /** Test/dev seam: pretend `path` contains `contents`. */
  _seedTraceFile(path: string, contents: unknown): void {
    this.traceFiles.set(path, contents);
  }

  async readCodeTraceFile(tracePath: string): Promise<TraceFile> {
    const raw = this.traceFiles.get(tracePath);
    if (raw === undefined) throw new Error(`Cannot read trace ${tracePath}: no such file`);
    return parseTraceFile(raw);
  }

  async indexCodeTrace(tracePath: string, workstreamId?: string | null): Promise<CodeTrace> {
    // Derive the indexed fields from the file rather than trusting a caller,
    // so the index can never drift from the file it points at.
    const parsed = await this.readCodeTraceFile(tracePath);
    const row: CodeTrace = {
      id: tracePath,
      workstream_id: workstreamId ?? null,
      test_name: parsed.test,
      trace_path: tracePath,
      commit_sha: parsed.commitSha,
      step_count: parsed.steps.length,
      truncated: parsed.truncated,
      recorded_at: parsed.recordedAt,
    };
    this.traceIndex.set(row.id, row);
    return row;
  }

  async listCodeTraces(workstreamId?: string | null): Promise<CodeTrace[]> {
    return Array.from(this.traceIndex.values())
      // Unscoped traces are included on purpose: the recorder CLI has no
      // workstream context, and filtering them out would hide every trace
      // recorded outside the app.
      .filter((t) => (workstreamId ? t.workstream_id === workstreamId || t.workstream_id === null : true))
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  }

  async getCodeTrace(id: string): Promise<CodeTrace | null> {
    return this.traceIndex.get(id) ?? null;
  }

  async deleteCodeTrace(id: string): Promise<void> {
    // Absent is fine: the UI may remove a row a re-record already replaced.
    this.traceIndex.delete(id);
  }

  /** Test/dev seam: the staleness verdict this backend should report. */
  _traceStaleness: TraceStaleness = "fresh";
  async traceStaleness(): Promise<TraceStaleness> {
    return this._traceStaleness;
  }

  /** Test/dev seam: the test names the picker should offer. */
  _rustTests: string[] = [];
  async listRustTests(
    _manifestDir?: string,
    query?: { package?: string; filter?: string },
  ): Promise<string[]> {
    const filter = query?.filter?.trim().toLowerCase();
    if (!filter) return this._rustTests;
    return this._rustTests.filter((test) => test.toLowerCase().includes(filter));
  }

  /**
   * Test/dev seam: pretend to record. Returns the path a real recorder would
   * have written, so the UI flow is exercisable with no debugger present.
   */
  _recordedTracePath: string | null = null;
  async recordCodeTrace(
    testName: string,
    _manifestDir?: string,
    _repoRoot?: string,
    _sessionId?: string | null,
    _maxSteps?: number,
    _packageName?: string | null,
  ): Promise<string> {
    if (this._recordedTracePath === null) {
      throw new Error(`Cannot record ${testName}: no recorder configured`);
    }
    return this._recordedTracePath;
  }

  // ── Project tracking ──────────────────────────────────────────────────

  private tasks = new Map<string, Task>();
  private labels = new Map<string, Label>();
  private taskEvents: TaskEvent[] = [];

  /** Deep copy so callers cannot mutate stored state through the returned tree. */
  private cloneTask(task: Task): Task {
    return {
      ...task,
      flags: [...task.flags],
      links: [...task.links],
      labelIds: [...task.labelIds],
      subtasks: task.subtasks.map((s) => ({ ...s })),
    };
  }

  /**
   * The task↔workstream relation is 1:1. Enforced here rather than only in the
   * UI so the CLI cannot create the ambiguity either: two tasks sharing a
   * workstream leaves the quick-note bar guessing which one a note belongs to.
   */
  private assertWorkstreamFree(workstreamId: string | null, taskId: string | null): void {
    if (!workstreamId) return;
    const holder = [...this.tasks.values()].find(
      (t) => t.workstreamId === workstreamId && t.id !== taskId,
    );
    if (holder) {
      throw new Error(
        `Workstream is already linked to the task "${holder.title}" — a workstream can only have one task`,
      );
    }
  }

  private requireTask(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  async listTasks(): Promise<Task[]> {
    return [...this.tasks.values()].map((t) => this.cloneTask(t));
  }

  async createTask(
    title: string,
    opts?: { status?: TaskStatus; workstreamId?: string | null; labelNames?: string[] },
  ): Promise<Task> {
    this.assertWorkstreamFree(opts?.workstreamId ?? null, null);
    const task = makeTask({
      id: generateId(),
      title,
      status: opts?.status,
      workstreamId: opts?.workstreamId ?? null,
      createdAt: now(),
    });
    this.tasks.set(task.id, task);
    if (opts?.labelNames?.length) await this.setTaskLabels(task.id, opts.labelNames);
    return this.cloneTask(this.requireTask(task.id));
  }

  async updateTask(id: string, updates: TaskUpdate): Promise<void> {
    const task = this.requireTask(id);
    if (updates.workstreamId !== undefined) {
      this.assertWorkstreamFree(updates.workstreamId, id);
    }
    if (updates.title !== undefined) task.title = updates.title;
    if (updates.flags !== undefined) task.flags = [...updates.flags];
    if (updates.links !== undefined) task.links = [...updates.links];
    if (updates.notes !== undefined) task.notes = updates.notes;
    if (updates.workstreamId !== undefined) task.workstreamId = updates.workstreamId;
    if (updates.status !== undefined) {
      task.status = updates.status;
      // `completedAt` is what the Done filter and the exporter key on, so it
      // has to be derived from the status rather than trusted from the caller
      // -- and cleared again when a finished task is reopened.
      task.completedAt = isTerminalStatus(updates.status) ? (task.completedAt ?? now()) : null;
    }
  }

  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
    this.taskEvents = this.taskEvents.filter((e) => e.taskId !== id);
  }

  async listLabels(): Promise<Label[]> {
    return [...this.labels.values()].map((l) => ({ ...l }));
  }

  async setTaskLabels(taskId: string, labelNames: string[]): Promise<Label[]> {
    const task = this.requireTask(taskId);
    const { labelIds, created } = resolveLabelNames(
      [...this.labels.values()],
      labelNames,
      generateId,
    );
    for (const label of created) this.labels.set(label.id, label);
    task.labelIds = labelIds;
    return this.listLabels();
  }

  async createSubtask(taskId: string, title: string): Promise<Subtask> {
    const task = this.requireTask(taskId);
    const subtask: Subtask = { id: generateId(), title, status: "todo" };
    task.subtasks.push(subtask);
    return { ...subtask };
  }

  async updateSubtask(
    id: string,
    updates: { title?: string; status?: TaskStatus },
  ): Promise<void> {
    for (const task of this.tasks.values()) {
      const subtask = task.subtasks.find((s) => s.id === id);
      if (!subtask) continue;
      if (updates.title !== undefined) subtask.title = updates.title;
      if (updates.status !== undefined) subtask.status = updates.status;
      return;
    }
    throw new Error(`Subtask not found: ${id}`);
  }

  async deleteSubtask(id: string): Promise<void> {
    for (const task of this.tasks.values()) {
      const at = task.subtasks.findIndex((s) => s.id === id);
      if (at >= 0) {
        task.subtasks.splice(at, 1);
        return;
      }
    }
  }

  async listTaskEvents(taskId?: string): Promise<TaskEvent[]> {
    const scoped = taskId ? this.taskEvents.filter((e) => e.taskId === taskId) : this.taskEvents;
    return sortEvents(scoped).map((e) => ({ ...e }));
  }

  async addTaskEvent(
    taskId: string,
    kind: TaskEventKind,
    text: string,
    source: TaskEventSource = "manual",
  ): Promise<TaskEvent> {
    this.requireTask(taskId);
    const event = makeEvent({ id: generateId(), taskId, kind, text, at: now(), source });
    this.taskEvents.push(event);
    return { ...event };
  }

  async deleteTaskEvent(id: string): Promise<void> {
    this.taskEvents = this.taskEvents.filter((e) => e.id !== id);
  }

  /**
   * In-memory devlog "filesystem". Pages written here are kept in a map so
   * tests and offline dev exercise the same clobber rule as the real export
   * without ever touching the user's wiki.
   */
  _devlogFiles = new Map<string, string>();

  async exportDevlogDay(
    directory: string,
    date: string,
    content: string,
    opts?: { commit?: boolean; push?: boolean },
  ): Promise<DevlogExportResult> {
    if (!directory) throw new Error("devlog directory is not configured");

    const writable = (p: string): boolean => {
      const existing = this._devlogFiles.get(p);
      return existing === undefined || isGeneratedByUs(existing);
    };

    const intended = pathJoin(directory, `${date}.md`);
    const ours = writable(intended);

    // Every fallback needs the same check as the intended path: the user may
    // have hand-written the alongside name too, and writing it blind would
    // destroy exactly what stepping aside was meant to protect. Mirrors
    // `resolve_target` in src-tauri/src/devlog.rs.
    let path = intended;
    if (!ours) {
      path = "";
      for (let suffix = 0; suffix < 100; suffix++) {
        const candidate = pathJoin(
          directory,
          suffix === 0 ? `${date}.workstreams.md` : `${date}.workstreams.${suffix}.md`,
        );
        if (writable(candidate)) {
          path = candidate;
          break;
        }
      }
      if (!path) {
        throw new Error(
          `refusing to write: ${date}.md and every alongside name are files Workstreams did not generate`,
        );
      }
    }

    this._devlogFiles.set(path, content);

    return {
      path,
      wroteAlongside: !ours,
      warning: ours
        ? ""
        : `${date}.md was not generated by Workstreams, so it was left untouched and the export was written alongside it.`,
      commit: opts?.commit === false ? "" : "memory0000",
      pushed: opts?.push === true,
    };
  }
}
