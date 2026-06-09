import { describe, expect, it } from "vitest";
import type { Tile } from "../types";
import { rewriteTileCwd, summarizeTilesToRestart } from "../worktree-change";

function createTile(overrides: Partial<Tile>): Tile {
  return {
    id: "tile-1",
    workstream_id: "workstream-1",
    tile_type: "terminal",
    title: null,
    config_json: "{}",
    created_at: "2026-05-28T00:00:00.000Z",
    updated_at: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("rewriteTileCwd", () => {
  it("updates cwd for terminal config while preserving other fields", () => {
    const result = rewriteTileCwd(JSON.stringify({ cwd: "C:\\old", shell: "pwsh.exe" }), "C:\\new", "terminal");

    expect(JSON.parse(result)).toEqual({ cwd: "C:\\new", shell: "pwsh.exe" });
  });

  it("adds cwd when missing on a terminal config", () => {
    const result = rewriteTileCwd(JSON.stringify({ shell: "bash" }), "/repo/worktree", "terminal");

    expect(JSON.parse(result)).toEqual({ shell: "bash", cwd: "/repo/worktree" });
  });

  it("updates cwd for copilot_session config while preserving other fields", () => {
    const result = rewriteTileCwd(
      JSON.stringify({ session_name: "Agent", command_template: "copilot", cwd: "C:\\old", is_resumed: false }),
      "C:\\repo\\feature",
      "copilot_session",
    );

    expect(JSON.parse(result)).toEqual({
      session_name: "Agent",
      command_template: "copilot",
      cwd: "C:\\repo\\feature",
      is_resumed: false,
    });
  });

  it("returns input string byte-identical for non-cwd tile types", () => {
    const configJson = '{  "path" : "README.md", "nested": { "keep" : true } }';

    expect(rewriteTileCwd(configJson, "C:\\new", "file_explorer")).toBe(configJson);
  });

  it("throws on malformed JSON", () => {
    expect(() => rewriteTileCwd("{ not json", "C:\\new", "terminal")).toThrow(/^Invalid tile config JSON: /);
  });

  it("wraps a non-object payload (e.g. array) into a fresh { cwd } object", () => {
    // Arrays and primitives aren't isJsonObject — fall to the false branch.
    expect(rewriteTileCwd(JSON.stringify([1, 2, 3]), "/repo", "terminal")).toBe(JSON.stringify({ cwd: "/repo" }));
    expect(rewriteTileCwd(JSON.stringify(null), "/repo", "terminal")).toBe(JSON.stringify({ cwd: "/repo" }));
  });
});

describe("summarizeTilesToRestart", () => {
  it("counts only terminal and copilot_session tiles and returns titles in input order", () => {
    const tiles = [
      createTile({ id: "file", tile_type: "file_explorer", title: "Files" }),
      createTile({ id: "terminal", tile_type: "terminal", title: "Shell" }),
      createTile({ id: "doc", tile_type: "doc_viewer", title: "Docs" }),
      createTile({ id: "copilot", tile_type: "copilot_session", title: "Agent" }),
    ];

    expect(summarizeTilesToRestart(tiles)).toEqual({ count: 2, labels: ["Shell", "Agent"] });
  });

  it("falls back to tile_type when title is null", () => {
    const tiles = [createTile({ tile_type: "terminal", title: null })];

    expect(summarizeTilesToRestart(tiles)).toEqual({ count: 1, labels: ["terminal"] });
  });
});
