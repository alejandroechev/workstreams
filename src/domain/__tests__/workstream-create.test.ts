/**
 * "E2E" integration tests for the workstream creation flow.
 *
 * These drive `createWorkstreamFlow` against a real `MemoryBackend` and
 * verify the full lifecycle for every (repo × session) combination:
 *  - import_worktree / new session  *
 *  - import_worktree / existing session
 *  - base_repo / new session
 *  - base_repo / existing session
 *  - worktree / new session
 *  - worktree / existing session
 *
 * The session choice itself doesn't affect what `createWorkstreamFlow`
 * produces (it always creates a pinned tile); it only affects what the App
 * does next (spawn vs picker). We cover that branch via the unit tests on
 * `WorkstreamCreateForm` and through behavior assertions on the tile config.
 */
import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../../backend/memory-backend";
import { createWorkstreamFlow } from "../workstream-create";

const baseInput = {
  name: "Feature X",
  directory: "C:\\repo",
  projectId: "p1",
  worktreeBranch: undefined as string | undefined,
  baseBranch: undefined as string | undefined,
};

describe("createWorkstreamFlow", () => {
  it.each([
    ["base_repo", "new"],
    ["base_repo", "existing"],
    ["import_worktree", "new"],
    ["import_worktree", "existing"],
  ] as const)("creates a WS with a pinned session tile for %s / %s", async (repoType, sessionChoice) => {
    const backend = new MemoryBackend();
    const result = await createWorkstreamFlow(
      backend,
      { ...baseInput, workstreamType: repoType, sessionChoice },
    );
    expect(result.workstream.name).toBe("Feature X");
    expect(result.workstream.workstream_type).toBe(repoType);
    expect(result.effectiveDirectory).toBe("C:\\repo");
    expect(result.pinnedTile.tile_type).toBe("copilot_session");
    const cfg = JSON.parse(result.pinnedTile.config_json);
    expect(cfg.pinned).toBe(true);
    expect(cfg.cwd).toBe("C:\\repo");
    // Layout has the pinned tile in the order
    const layout = await backend.getLayout(result.workstream.id);
    expect(JSON.parse(layout!.tile_order_json)).toEqual([result.pinnedTile.id]);
  });

  it("creates a worktree WS at the pre-derived directory in a 'creating' state", async () => {
    const backend = new MemoryBackend();
    const result = await createWorkstreamFlow(
      backend,
      {
        ...baseInput,
        workstreamType: "worktree",
        worktreeBranch: "alejandroe/feature-x",
        effectiveDirectory: "C:\\repo-worktrees\\feature-x",
        initialStatus: "creating",
        sessionChoice: "new",
      },
    );
    // The flow no longer creates the worktree itself (that runs non-blocking
    // afterwards); it records the ws with the pre-derived directory + status.
    expect(result.effectiveDirectory).toBe("C:\\repo-worktrees\\feature-x");
    expect(result.workstream.directory).toBe("C:\\repo-worktrees\\feature-x");
    expect(result.workstream.status).toBe("creating");
    const cfg = JSON.parse(result.pinnedTile.config_json);
    expect(cfg.cwd).toBe("C:\\repo-worktrees\\feature-x");
    // Persisted status is creating.
    const stored = (await backend.listWorkstreams()).find((w) => w.id === result.workstream.id);
    expect(stored?.status).toBe("creating");
  });

  it("defaults effectiveDirectory to directory and status to active", async () => {
    const backend = new MemoryBackend();
    const result = await createWorkstreamFlow(
      backend,
      { ...baseInput, workstreamType: "base_repo", sessionChoice: "new" },
    );
    expect(result.effectiveDirectory).toBe("C:\\repo");
    expect(result.workstream.status).toBe("active");
  });

  it("throws if worktree branch is missing for workstream_type=worktree", async () => {
    const backend = new MemoryBackend();
    await expect(
      createWorkstreamFlow(
        backend,
        { ...baseInput, workstreamType: "worktree", sessionChoice: "new" },
      ),
    ).rejects.toThrow(/worktreeBranch is required/);
  });
});
