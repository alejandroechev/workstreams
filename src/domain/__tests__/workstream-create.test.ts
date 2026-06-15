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
import { describe, it, expect, vi } from "vitest";
import { MemoryBackend } from "../../backend/memory-backend";
import { createWorkstreamFlow } from "../workstream-create";

const baseInput = {
  name: "Feature X",
  directory: "C:\\repo",
  projectId: "p1",
  worktreeBranch: undefined as string | undefined,
  baseBranch: undefined as string | undefined,
};

const noWorktree = vi.fn(async () => {
  throw new Error("create_worktree should not be called for this type");
});

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
      noWorktree,
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

  it("calls create_worktree and uses returned directory for workstream_type=worktree", async () => {
    const backend = new MemoryBackend();
    const createWorktree = vi.fn(async () => "C:\\repo-worktrees\\feature-x");
    const result = await createWorkstreamFlow(
      backend,
      { ...baseInput, workstreamType: "worktree", worktreeBranch: "alejandroe/feature-x", sessionChoice: "new" },
      createWorktree,
    );
    expect(createWorktree).toHaveBeenCalledWith("C:\\repo", "alejandroe/feature-x", null, false);
    expect(result.effectiveDirectory).toBe("C:\\repo-worktrees\\feature-x");
    expect(result.workstream.directory).toBe("C:\\repo-worktrees\\feature-x");
    const cfg = JSON.parse(result.pinnedTile.config_json);
    expect(cfg.cwd).toBe("C:\\repo-worktrees\\feature-x");
  });

  it("forwards baseBranch when provided for worktree creation", async () => {
    const backend = new MemoryBackend();
    const createWorktree = vi.fn(async () => "C:\\repo-worktrees\\f");
    await createWorkstreamFlow(
      backend,
      { ...baseInput, workstreamType: "worktree", worktreeBranch: "f", baseBranch: "main", sessionChoice: "new" },
      createWorktree,
    );
    expect(createWorktree).toHaveBeenCalledWith("C:\\repo", "f", "main", false);
  });

  it("forwards pullBaseFirst=true when the user opts in", async () => {
    const backend = new MemoryBackend();
    const createWorktree = vi.fn(async () => "C:\\repo-worktrees\\f");
    await createWorkstreamFlow(
      backend,
      { ...baseInput, workstreamType: "worktree", worktreeBranch: "f", baseBranch: "main", pullBaseFirst: true, sessionChoice: "new" },
      createWorktree,
    );
    expect(createWorktree).toHaveBeenCalledWith("C:\\repo", "f", "main", true);
  });

  it("throws if worktree branch is missing for workstream_type=worktree", async () => {
    const backend = new MemoryBackend();
    await expect(
      createWorkstreamFlow(
        backend,
        { ...baseInput, workstreamType: "worktree", sessionChoice: "new" },
        noWorktree,
      ),
    ).rejects.toThrow(/worktreeBranch is required/);
  });

  it("propagates create_worktree failures (does not create a WS)", async () => {
    const backend = new MemoryBackend();
    const createWorktree = vi.fn(async () => { throw new Error("git worktree add failed: branch exists"); });
    await expect(
      createWorkstreamFlow(
        backend,
        { ...baseInput, workstreamType: "worktree", worktreeBranch: "f", sessionChoice: "new" },
        createWorktree,
      ),
    ).rejects.toThrow(/git worktree add failed/);
    const list = await backend.listWorkstreams();
    expect(list).toHaveLength(0);
  });
});
