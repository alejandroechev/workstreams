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
import type { Workstream, Tile } from "./types";

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
}

export interface CreateWorkstreamResult {
  workstream: Workstream;
  pinnedTile: Tile;
  effectiveDirectory: string;
}

export type CreateWorktreeFn = (
  projectDirectory: string,
  branchName: string,
  baseBranch: string | null,
  pullBaseFirst: boolean,
) => Promise<string>;

export async function createWorkstreamFlow(
  backend: Backend,
  input: CreateWorkstreamInput,
  createWorktree: CreateWorktreeFn,
): Promise<CreateWorkstreamResult> {
  let effectiveDirectory = input.directory;
  if (input.workstreamType === "worktree") {
    if (!input.worktreeBranch) {
      throw new Error("worktreeBranch is required when workstreamType=worktree");
    }
    effectiveDirectory = await createWorktree(
      input.directory,
      input.worktreeBranch,
      input.baseBranch ?? null,
      input.pullBaseFirst ?? false,
    );
  }

  const workstream = await backend.createWorkstream(input.name, effectiveDirectory, {
    projectId: input.projectId,
    workstreamType: input.workstreamType,
    worktreeBranch: input.worktreeBranch,
  });

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
