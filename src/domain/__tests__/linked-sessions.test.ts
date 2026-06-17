import { describe, it, expect } from "vitest";
import { deriveLinkedSessionIds } from "../linked-sessions";
import type { Tile } from "../types";

const now = new Date().toISOString();
function tile(partial: Partial<Tile> & { tile_type: Tile["tile_type"]; config_json: string }): Tile {
  return {
    id: partial.id ?? "t1",
    workstream_id: partial.workstream_id ?? "w1",
    tile_type: partial.tile_type,
    title: partial.title ?? null,
    config_json: partial.config_json,
    created_at: now,
    updated_at: now,
  };
}

describe("deriveLinkedSessionIds", () => {
  it("returns ids from copilot_session tiles with copilot_session_id", () => {
    const tiles = [
      tile({ id: "a", tile_type: "copilot_session", config_json: JSON.stringify({ copilot_session_id: "s1" }) }),
      tile({ id: "b", tile_type: "copilot_session", config_json: JSON.stringify({ copilot_session_id: "s2" }) }),
    ];
    expect(deriveLinkedSessionIds(tiles)).toEqual(["s1", "s2"]);
  });

  it("falls back to resume_by_id when copilot_session_id is absent", () => {
    const tiles = [
      tile({ tile_type: "copilot_session", config_json: JSON.stringify({ resume_by_id: "legacy" }) }),
    ];
    expect(deriveLinkedSessionIds(tiles)).toEqual(["legacy"]);
  });

  it("ignores non-copilot tiles", () => {
    const tiles = [
      tile({ tile_type: "terminal", config_json: JSON.stringify({ copilot_session_id: "nope" }) }),
      tile({ tile_type: "session_meta", config_json: "{}" }),
    ];
    expect(deriveLinkedSessionIds(tiles)).toEqual([]);
  });

  it("skips unlinked copilot tiles (no id)", () => {
    const tiles = [
      tile({ id: "a", tile_type: "copilot_session", config_json: JSON.stringify({ session_name: "x" }) }),
      tile({ id: "b", tile_type: "copilot_session", config_json: JSON.stringify({ copilot_session_id: "s1" }) }),
    ];
    expect(deriveLinkedSessionIds(tiles)).toEqual(["s1"]);
  });

  it("tolerates malformed config_json", () => {
    const tiles = [
      tile({ id: "a", tile_type: "copilot_session", config_json: "{ not json" }),
      tile({ id: "b", tile_type: "copilot_session", config_json: JSON.stringify({ copilot_session_id: "s1" }) }),
    ];
    expect(deriveLinkedSessionIds(tiles)).toEqual(["s1"]);
  });

  it("preserves tile order", () => {
    const tiles = [
      tile({ id: "a", tile_type: "copilot_session", config_json: JSON.stringify({ copilot_session_id: "z" }) }),
      tile({ id: "b", tile_type: "copilot_session", config_json: JSON.stringify({ copilot_session_id: "a" }) }),
    ];
    expect(deriveLinkedSessionIds(tiles)).toEqual(["z", "a"]);
  });

  it("returns an empty array for no tiles", () => {
    expect(deriveLinkedSessionIds([])).toEqual([]);
  });

  it("produces a stable join key for identical content across two workstreams' computations", () => {
    const a = deriveLinkedSessionIds([
      tile({ tile_type: "copilot_session", config_json: JSON.stringify({ copilot_session_id: "s1" }) }),
    ]);
    const b = deriveLinkedSessionIds([
      tile({ tile_type: "copilot_session", config_json: JSON.stringify({ copilot_session_id: "s1" }) }),
    ]);
    // Different array refs, same content — the join key consumers rely on
    // must match so dependent effects don't re-fire spuriously.
    expect(a).not.toBe(b);
    expect(a.join("|")).toBe(b.join("|"));
  });
});
