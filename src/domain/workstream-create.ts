/**
 * Pure orchestration for the workstream creation flow.
 *
 * Given a backend + a callable for `create_worktree` (so we don't have to
 * mock the global Tauri `invoke` here), produces:
 *  - the new Workstream record
 *  - the pinned `copilot_session` tile
 *  - the effective working directory (post-worktree creation when applicable)
 *
 * The caller is responsible for spawning agency.exe and/or opening the
 * SessionPicker afterwards — those have UI side-effects.
 */
import type { Backend } from "../backend/types";
import type { Workstream, Tile, WorkstreamStatus } from "./types";

export interface CreateWorkstreamInput {
  name: string;
  directory: string;
  projectId?: string;
  workstreamType: "import_worktree" | "base_repo" | "worktree";
  worktreeBranch?: string;
  baseBranch?: string;
  sessionChoice: "new" | "existing";
  /** When workstreamType is "worktree", first fetch + fast-forward the
   *  local base branch so the new worktree starts from latest. Default
   *  false (form passes the user's checkbox value). */
  pullBaseFirst?: boolean;
  /**
   * Pre-resolved working directory. For worktree creation the caller derives
   * the worktree path up front (via `derive_worktree_path`) and passes it
   * here so the workstream record is created with its final directory before
   * the (non-blocking) `git worktree add` runs. Defaults to `directory`.
   */
  effectiveDirectory?: string;
  /**
   * Initial workstream status. Worktree creation passes `"creating"` so the
   * row shows up immediately in a provisioning state; everything else stays
   * `"active"`. Defaults to `"active"`.
   */
  initialStatus?: WorkstreamStatus;
}

export interface CreateWorkstreamResult {
  workstream: Workstream;
  pinnedTile: Tile;
  effectiveDirectory: string;
}

export async function createWorkstreamFlow(
  backend: Backend,
  input: CreateWorkstreamInput,
): Promise<CreateWorkstreamResult> {
  if (input.workstreamType === "worktree" && !input.worktreeBranch) {
    throw new Error("worktreeBranch is required when workstreamType=worktree");
  }
  // The worktree path is derived up front by the caller and passed in; the
  // actual `git worktree add` runs non-blocking *after* this returns. For
  // non-worktree types the effective directory is just the chosen directory.
  const effectiveDirectory = input.effectiveDirectory ?? input.directory;

  const workstream = await backend.createWorkstream(input.name, effectiveDirectory, {
    projectId: input.projectId,
    workstreamType: input.workstreamType,
    worktreeBranch: input.worktreeBranch,
  });

  // Persist a non-default initial status (e.g. "creating" for worktrees).
  if (input.initialStatus && input.initialStatus !== "active") {
    await backend.updateWorkstream(workstream.id, { status: input.initialStatus });
    workstream.status = input.initialStatus;
  }

  const config = JSON.stringify({
    session_name: input.name,
    command_template: "agency copilot --yolo",
    cwd: effectiveDirectory,
    is_resumed: false,
    pinned: true,
    created_at: new Date().toISOString(),
  });

  const pinnedTile = await backend.createTile(workstream.id, "copilot_session", input.name, config);
  await backend.updateLayout(workstream.id, { tile_order_json: JSON.stringify([pinnedTile.id]) });

  return { workstream, pinnedTile, effectiveDirectory };
}
