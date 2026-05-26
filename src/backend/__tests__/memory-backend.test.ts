import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../memory-backend";
import type { DiffReview } from "../../domain/diff-review";

describe("MemoryBackend", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  describe("workstreams", () => {
    it("starts empty", async () => {
      const ws = await backend.listWorkstreams();
      expect(ws).toEqual([]);
    });

    it("creates and lists a workstream", async () => {
      const ws = await backend.createWorkstream("My Project", "C:\\project");
      expect(ws.name).toBe("My Project");
      expect(ws.directory).toBe("C:\\project");
      expect(ws.status).toBe("active");
      expect(ws.id).toBeTruthy();

      const list = await backend.listWorkstreams();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(ws.id);
    });

    it("updates a workstream", async () => {
      const ws = await backend.createWorkstream("Old Name", "C:\\");
      await backend.updateWorkstream(ws.id, { name: "New Name" });

      const list = await backend.listWorkstreams();
      expect(list[0].name).toBe("New Name");
    });

    it("throws when updating non-existent workstream", async () => {
      await expect(
        backend.updateWorkstream("nonexistent", { name: "x" })
      ).rejects.toThrow("Workstream not found");
    });

    it("deletes a workstream", async () => {
      const ws = await backend.createWorkstream("To Delete", "C:\\");
      await backend.deleteWorkstream(ws.id);

      const list = await backend.listWorkstreams();
      expect(list).toHaveLength(0);
    });

    it("deletes associated tiles when workstream is deleted", async () => {
      const ws = await backend.createWorkstream("WS", "C:\\");
      await backend.createTile(ws.id, "terminal", "T1", "{}");
      await backend.deleteWorkstream(ws.id);

      const tiles = await backend.listTiles(ws.id);
      expect(tiles).toHaveLength(0);
    });
  });

  describe("tiles", () => {
    let wsId: string;

    beforeEach(async () => {
      const ws = await backend.createWorkstream("Test WS", "C:\\");
      wsId = ws.id;
    });

    it("creates and lists tiles", async () => {
      const tile = await backend.createTile(wsId, "terminal", "My Terminal", '{"cwd":"C:\\\\"}');
      expect(tile.tile_type).toBe("terminal");
      expect(tile.title).toBe("My Terminal");

      const tiles = await backend.listTiles(wsId);
      expect(tiles).toHaveLength(1);
      expect(tiles[0].id).toBe(tile.id);
    });

    it("only lists tiles for the given workstream", async () => {
      const ws2 = await backend.createWorkstream("Other WS", "D:\\");
      await backend.createTile(wsId, "terminal", "T1", "{}");
      await backend.createTile(ws2.id, "code_viewer", "C1", "{}");

      const tiles1 = await backend.listTiles(wsId);
      expect(tiles1).toHaveLength(1);
      expect(tiles1[0].tile_type).toBe("terminal");

      const tiles2 = await backend.listTiles(ws2.id);
      expect(tiles2).toHaveLength(1);
      expect(tiles2[0].tile_type).toBe("code_viewer");
    });

    it("deletes a tile", async () => {
      const tile = await backend.createTile(wsId, "terminal", "T1", "{}");
      await backend.deleteTile(tile.id);

      const tiles = await backend.listTiles(wsId);
      expect(tiles).toHaveLength(0);
    });
  });

  describe("layout", () => {
    it("returns default layout for new workstream", async () => {
      const ws = await backend.createWorkstream("WS", "C:\\");
      const layout = await backend.getLayout(ws.id);
      expect(layout.workstream_id).toBe(ws.id);
      expect(layout.tile_order_json).toBe("[]");
      expect(layout.fullscreen_tile_id).toBeNull();
    });

    it("updates layout", async () => {
      const ws = await backend.createWorkstream("WS", "C:\\");
      await backend.updateLayout(ws.id, {
        tile_order_json: '["a","b"]',
        fullscreen_tile_id: "a",
      });

      const layout = await backend.getLayout(ws.id);
      expect(layout.tile_order_json).toBe('["a","b"]');
      expect(layout.fullscreen_tile_id).toBe("a");
    });

    it("returns default layout for unknown workstream", async () => {
      const layout = await backend.getLayout("unknown");
      expect(layout.tile_order_json).toBe("[]");
    });
  });

  describe("files", () => {
    it("reads seeded files", async () => {
      backend.seedFile("/test.txt", "hello world");
      const content = await backend.readFile("/test.txt");
      expect(content).toBe("hello world");
    });

    it("throws for non-existent files", async () => {
      await expect(backend.readFile("/nope")).rejects.toThrow("File not found");
    });
  });

  describe("scrollback", () => {
    it("saves and loads scrollback", async () => {
      await backend.saveScrollback("tile-1", "scrollback data");
      const data = await backend.loadScrollback("tile-1");
      expect(data).toBe("scrollback data");
    });

    it("returns null for no scrollback", async () => {
      const data = await backend.loadScrollback("tile-unknown");
      expect(data).toBeNull();
    });
  });

  describe("terminal lifecycle", () => {
    it("spawns and closes terminals", async () => {
      await backend.spawnTerminal("t1", "C:\\");
      // Writing should work after spawn
      await expect(backend.writeToTerminal("t1", "ls")).resolves.toBeUndefined();
      await backend.closeTerminal("t1");
      // Writing should fail after close
      await expect(backend.writeToTerminal("t1", "ls")).rejects.toThrow("No terminal");
    });

    it("resizing non-existent terminal throws", async () => {
      await expect(backend.resizeTerminal("nope", 30, 120)).rejects.toThrow("No terminal");
    });

    it("spawnCopilotSession records the call and registers the terminal", async () => {
      // Clear the cross-test invoke log.
      (window as unknown as { __WS_INVOKE_LOG__?: unknown[] }).__WS_INVOKE_LOG__ = [];
      const pid = await backend.spawnCopilotSession("t-copilot", "C:\\repo", "abc-123", 30, 120);
      expect(pid).toBeNull();
      // Writing afterwards must work — terminal was registered.
      await expect(backend.writeToTerminal("t-copilot", "x")).resolves.toBeUndefined();
      const log = (window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> }).__WS_INVOKE_LOG__ ?? [];
      const entry = log.find((e) => e.cmd === "spawn_copilot_session");
      expect(entry).toBeTruthy();
      expect(entry!.args.resumeSessionId).toBe("abc-123");
      expect(entry!.args.tileId).toBe("t-copilot");
    });

    it("spawnCopilotSession defaults resumeSessionId to null", async () => {
      (window as unknown as { __WS_INVOKE_LOG__?: unknown[] }).__WS_INVOKE_LOG__ = [];
      await backend.spawnCopilotSession("t-fresh", "C:\\repo");
      const log = (window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> }).__WS_INVOKE_LOG__ ?? [];
      const entry = log.find((e) => e.cmd === "spawn_copilot_session");
      expect(entry!.args.resumeSessionId).toBeNull();
    });

    it("spawnTerminal also records to the invoke log when a window is present", async () => {
      (window as unknown as { __WS_INVOKE_LOG__?: unknown[] }).__WS_INVOKE_LOG__ = [];
      await backend.spawnTerminal("t-term", "C:\\", "pwsh.exe", ["-NoLogo"]);
      const log = (window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> }).__WS_INVOKE_LOG__ ?? [];
      const entry = log.find((e) => e.cmd === "spawn_terminal");
      expect(entry!.args.command).toBe("pwsh.exe");
    });
  });

  describe("git info", () => {
    it("returns null repo and branch by default", async () => {
      const info = await backend.detectGitInfo("C:\\anything");
      expect(info.repo).toBeNull();
      expect(info.branch).toBeNull();
    });
  });

  describe("searchFiles", () => {
    it("returns matching files by name", async () => {
      backend.seedFile("/project/src/main.ts", "");
      backend.seedFile("/project/src/utils.ts", "");
      backend.seedFile("/project/readme.md", "");

      const results = await backend.searchFiles("/project", "main");
      expect(results).toEqual(["/project/src/main.ts"]);
    });

    it("is case-insensitive", async () => {
      backend.seedFile("/project/App.tsx", "");
      const results = await backend.searchFiles("/project", "app");
      expect(results).toEqual(["/project/App.tsx"]);
    });

    it("returns empty for no matches", async () => {
      backend.seedFile("/project/index.ts", "");
      const results = await backend.searchFiles("/project", "zzz");
      expect(results).toEqual([]);
    });
  });

  describe("searchInFiles", () => {
    it("finds matches across files with line numbers (case-insensitive)", async () => {
      backend.seedFile("/p/a.ts", "Hello World\nanother line\n");
      backend.seedFile("/p/b.ts", "nothing here\nwOrLd peace\n");
      const results = await backend.searchInFiles("/p", "world");
      const sorted = [...results].sort((x, y) => x.path.localeCompare(y.path));
      expect(sorted).toEqual([
        { path: "/p/a.ts", line_number: 1, line_text: "Hello World" },
        { path: "/p/b.ts", line_number: 2, line_text: "wOrLd peace" },
      ]);
    });

    it("returns empty for blank query", async () => {
      backend.seedFile("/p/a.ts", "anything");
      const results = await backend.searchInFiles("/p", "   ");
      expect(results).toEqual([]);
    });

    it("respects the limit argument", async () => {
      for (let i = 0; i < 10; i++) {
        backend.seedFile(`/p/f${i}.ts`, "needle\n");
      }
      const results = await backend.searchInFiles("/p", "needle", 3);
      expect(results.length).toBe(3);
    });
  });

  describe("gitDiff", () => {
    it("gitDiffFiles returns empty array", async () => {
      const files = await backend.gitDiffFiles("C:\\project", "unstaged");
      expect(files).toEqual([]);
    });

    it("gitDiffFile returns empty string", async () => {
      const diff = await backend.gitDiffFile("C:\\project", "file.ts", "unstaged");
      expect(diff).toBe("");
    });
  });

  describe("discoverCopilotConfig", () => {
    it("returns empty array by default", async () => {
      const items = await backend.discoverCopilotConfig();
      expect(items).toEqual([]);
    });

    it("returns empty array with workstream dir", async () => {
      const items = await backend.discoverCopilotConfig("C:\\project");
      expect(items).toEqual([]);
    });
  });

  describe("session plan/todo introspection", () => {
    it("returns empty defaults", async () => {
      expect(await backend.listSessionPlans("s")).toEqual([]);
      expect(await backend.getCurrentSessionPlan("s")).toBeNull();
      expect(await backend.listSessionTodoDeps("s")).toEqual([]);
      expect(await backend.listSessionTodos("s")).toEqual([]);
    });
  });

  describe("diff review", () => {
    function review(id: string, workstreamId: string, status: DiffReview["status"], createdAt: string): DiffReview {
      return {
        id,
        workstream_id: workstreamId,
        diff_source: "branch",
        source_ref: "main",
        status,
        plan_json: null,
        exported_path: null,
        created_at: createdAt,
        updated_at: createdAt,
        completed_at: null,
      };
    }

    it("lists active diff reviews by workstream ordered by creation desc then id asc", async () => {
      backend.seedDiffReview({ review: review("rev-b", "ws-1", "active", "2026-05-26T10:00:00.000Z"), chunks: [], hunks: [] });
      backend.seedDiffReview({ review: review("rev-done", "ws-1", "completed", "2026-05-26T11:00:00.000Z"), chunks: [], hunks: [] });
      backend.seedDiffReview({ review: review("rev-a", "ws-1", "active", "2026-05-26T10:00:00.000Z"), chunks: [], hunks: [] });
      backend.seedDiffReview({ review: review("rev-other", "ws-2", "active", "2026-05-26T12:00:00.000Z"), chunks: [], hunks: [] });

      const active = await backend.listActiveDiffReviews("ws-1");

      expect(active.map((r) => r.id)).toEqual(["rev-a", "rev-b"]);
    });

    it("creates or focuses diff review tiles idempotently per workstream and review", async () => {
      const ws1 = await backend.createWorkstream("WS 1", "C:\\one");
      const ws2 = await backend.createWorkstream("WS 2", "C:\\two");

      const first = await backend.createOrFocusDiffReviewTile(ws1.id, "rev-1");
      expect(first.tile_type).toBe("diff_review");
      expect(first.title).toBe("Review: rev-1");
      expect(JSON.parse(first.config_json)).toEqual({ reviewId: "rev-1" });
      await expect(backend.getLayout(ws1.id)).resolves.toMatchObject({
        tile_order_json: JSON.stringify([first.id]),
      });

      const focused = await backend.createOrFocusDiffReviewTile(ws1.id, "rev-1");
      expect(focused.id).toBe(first.id);
      expect(JSON.parse((await backend.getLayout(ws1.id)).tile_order_json)).toEqual([first.id]);

      const secondReviewTile = await backend.createOrFocusDiffReviewTile(ws1.id, "rev-2");
      expect(secondReviewTile.id).not.toBe(first.id);
      expect(JSON.parse((await backend.getLayout(ws1.id)).tile_order_json)).toEqual([first.id, secondReviewTile.id]);

      const otherWorkstreamTile = await backend.createOrFocusDiffReviewTile(ws2.id, "rev-1");
      expect(otherWorkstreamTile.id).not.toBe(first.id);
      expect(JSON.parse((await backend.getLayout(ws2.id)).tile_order_json)).toEqual([otherWorkstreamTile.id]);
    });

    it("creates a review in planning status", async () => {
      const review = await backend.createDiffReview("ws-1", "branch", "main");
      expect(review.status).toBe("planning");
      expect(review.diff_source).toBe("branch");
      expect(review.source_ref).toBe("main");
      expect(await backend.getReview(review.id)).toEqual(review);
    });

    it("setReviewPlan transitions to active", async () => {
      const review = await backend.createDiffReview("ws-1", "branch", "main");
      await backend.setReviewPlan(review.id, "{\"clusters\":[]}");
      const updated = await backend.getReview(review.id);
      expect(updated.status).toBe("active");
      expect(updated.plan_json).toBe("{\"clusters\":[]}");
    });

    it("setReviewPlan / getReview throw for unknown ids", async () => {
      await expect(backend.setReviewPlan("nope", "{}")).rejects.toThrow();
      await expect(backend.getReview("nope")).rejects.toThrow();
    });

    it("seeds + lists chunks sorted by ordinal", async () => {
      const review = await backend.createDiffReview("ws-1", "working_tree", null);
      backend.seedDiffReview({
        review,
        chunks: [
          { id: "c2", review_id: review.id, ordinal: 2, title: "B", summary: null, is_trivial: false, state: "pending", question_text: null, question_style: null, invalidated_at: null, created_at: "t", updated_at: "t" },
          { id: "c1", review_id: review.id, ordinal: 1, title: "A", summary: null, is_trivial: false, state: "pending", question_text: null, question_style: null, invalidated_at: null, created_at: "t", updated_at: "t" },
        ],
        hunks: [
          { id: "h1", chunk_id: "c1", file_path: "f.ts", old_start: 1, old_lines: 1, new_start: 1, new_lines: 2, patch_text: "@@", content_hash: "abc" },
        ],
      });
      const chunks = await backend.listChunks(review.id);
      expect(chunks.map((c) => c.id)).toEqual(["c1", "c2"]);
      const details = await backend.getChunkDetails("c1");
      expect(details.hunks).toHaveLength(1);
      expect(details.comments).toEqual([]);
    });

    it("getChunkDetails throws for unknown chunks", async () => {
      await expect(backend.getChunkDetails("missing")).rejects.toThrow();
    });

    it("activateChunk marks pending → seen and is idempotent for non-pending", async () => {
      const review = await backend.createDiffReview("ws-1", "branch", null);
      backend.seedDiffReview({
        review,
        chunks: [
          { id: "c1", review_id: review.id, ordinal: 1, title: "A", summary: null, is_trivial: false, state: "pending", question_text: null, question_style: null, invalidated_at: null, created_at: "t", updated_at: "t" },
        ],
        hunks: [],
      });
      await backend.activateChunk(review.id, "c1");
      let d = await backend.getChunkDetails("c1");
      expect(d.chunk.state).toBe("seen");
      // already approved: do not regress to seen
      await backend.ackChunk("c1", "approved");
      await backend.activateChunk(review.id, "c1");
      d = await backend.getChunkDetails("c1");
      expect(d.chunk.state).toBe("approved");
    });

    it("activateChunk / ackChunk throw for unknown chunks", async () => {
      await expect(backend.activateChunk("r", "nope")).rejects.toThrow();
      await expect(backend.ackChunk("nope", "approved")).rejects.toThrow();
    });

    it("addComment appends and flips chunk state to commented", async () => {
      const review = await backend.createDiffReview("ws-1", "branch", null);
      backend.seedDiffReview({
        review,
        chunks: [
          { id: "c1", review_id: review.id, ordinal: 1, title: "A", summary: null, is_trivial: false, state: "seen", question_text: null, question_style: null, invalidated_at: null, created_at: "t", updated_at: "t" },
        ],
        hunks: [],
      });
      const comment = await backend.addComment("c1", "src/a.ts", 10, 12, "log level too high");
      expect(comment.text).toBe("log level too high");
      const details = await backend.getChunkDetails("c1");
      expect(details.comments).toHaveLength(1);
      expect(details.chunk.state).toBe("commented");
    });

    it("addComment throws for unknown chunks", async () => {
      await expect(backend.addComment("nope", "f", 1, 2, "x")).rejects.toThrow();
    });

    it("completeReview sets status + exported path", async () => {
      const review = await backend.createDiffReview("ws-1", "pr", "42");
      const result = await backend.completeReview(review.id);
      expect(result.exported_path).toContain(review.id);
      const r = await backend.getReview(review.id);
      expect(r.status).toBe("completed");
      expect(r.exported_path).toBe(result.exported_path);
      expect(r.completed_at).toBeTruthy();
    });

    it("completeReview throws for unknown reviews", async () => {
      await expect(backend.completeReview("nope")).rejects.toThrow();
    });

    it("detectDrift returns seeded invalidations", async () => {
      const review = await backend.createDiffReview("ws-1", "branch", null);
      expect(await backend.detectDrift(review.id)).toEqual([]);
      backend.seedDiffDrift(review.id, ["c1", "c3"]);
      expect((await backend.detectDrift(review.id)).sort()).toEqual(["c1", "c3"]);
    });
  });

  describe("terminals", () => {
    it("spawns and tracks a terminal", async () => {
      await backend.spawnTerminal("tile-1", "/", "bash");
      await backend.writeToTerminal("tile-1", "echo hi");
      await backend.resizeTerminal("tile-1", 24, 80);
      await backend.closeTerminal("tile-1");
      // After close, writing should throw
      await expect(backend.writeToTerminal("tile-1", "x")).rejects.toThrow();
    });

    it("throws when writing to non-existent terminal", async () => {
      await expect(backend.writeToTerminal("ghost", "x")).rejects.toThrow();
      await expect(backend.resizeTerminal("ghost", 1, 1)).rejects.toThrow();
    });
  });

  describe("scrollback + sessions", () => {
    it("saves and loads scrollback", async () => {
      await backend.saveScrollback("t1", "hello");
      expect(await backend.loadScrollback("t1")).toBe("hello");
    });

    it("returns null for unknown scrollback", async () => {
      expect(await backend.loadScrollback("none")).toBeNull();
    });

    it("watchSession/unwatchSession are no-ops", async () => {
      await expect(backend.watchSession("t1", "name")).resolves.toBeUndefined();
      await expect(backend.unwatchSession("t1")).resolves.toBeUndefined();
    });
  });

  describe("readFile + detectGitInfo", () => {
    it("reads seeded file", async () => {
      backend.seedFile("/a.txt", "hello");
      expect(await backend.readFile("/a.txt")).toBe("hello");
    });

    it("throws on missing file", async () => {
      await expect(backend.readFile("/missing")).rejects.toThrow();
    });

    it("detectGitInfo returns nulls", async () => {
      expect(await backend.detectGitInfo("/")).toEqual({ repo: null, branch: null });
    });

    it("listDirectory returns seeded files", async () => {
      backend.seedFile("/x/a.ts", "");
      backend.seedFile("/x/b.ts", "");
      const list = await backend.listDirectory("/x");
      expect(list.length).toBe(2);
    });

    it("listDirectory reports file size", async () => {
      backend.seedFile("/y/small.txt", "hi");
      backend.seedFile("/y/big.txt", "x".repeat(2048));
      const list = await backend.listDirectory("/y");
      const small = list.find((e) => e.name === "small.txt");
      const big = list.find((e) => e.name === "big.txt");
      expect(small?.size).toBe(2);
      expect(big?.size).toBe(2048);
      expect(small?.is_dir).toBe(false);
    });
  });

  describe("layout + git stubs", () => {
    it("getLayout returns default for unknown workstream", async () => {
      const layout = await backend.getLayout("unknown");
      expect(layout.workstream_id).toBe("unknown");
      expect(layout.layout_mode).toBe("auto");
      expect(layout.tile_order_json).toBe("[]");
    });

    it("updateLayout creates and updates", async () => {
      await backend.updateLayout("ws1", { layout_mode: "vertical" });
      const layout = await backend.getLayout("ws1");
      expect(layout.layout_mode).toBe("vertical");
    });

    it("gitLog returns stub commits", async () => {
      const log = await backend.gitLog("/");
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].hash).toBeTruthy();
    });

    it("gitShowCommit returns stub diff", async () => {
      const diff = await backend.gitShowCommit("/", "abc");
      expect(diff).toContain("commit");
    });

    it("gitCurrentBranch returns 'main'", async () => {
      expect(await backend.gitCurrentBranch("/")).toBe("main");
    });

    it("updateTileConfig updates config and title", async () => {
      const ws = await backend.createWorkstream("ws", "/");
      const tile = await backend.createTile(ws.id, "terminal", "t1", "{}");
      await backend.updateTileConfig(tile.id, '{"x":1}', "renamed");
      const tiles = await backend.listTiles(ws.id);
      expect(tiles[0].config_json).toBe('{"x":1}');
      expect(tiles[0].title).toBe("renamed");
    });

    it("updateTileConfig handles missing tile gracefully", async () => {
      await expect(backend.updateTileConfig("missing", "{}")).resolves.toBeUndefined();
    });
  });
});
