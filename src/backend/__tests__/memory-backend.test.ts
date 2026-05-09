import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../memory-backend";

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
});
