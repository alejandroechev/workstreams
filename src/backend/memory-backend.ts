import type { Workstream, Tile, TileType, WorkstreamLayout } from "../domain/types";
import type { Backend } from "./types";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * In-memory Backend implementation for tests and offline development.
 * Stores all data in Maps — no Tauri dependency.
 */
export class MemoryBackend implements Backend {
  private workstreams = new Map<string, Workstream>();
  private tiles = new Map<string, Tile>();
  private layouts = new Map<string, WorkstreamLayout>();
  private scrollbacks = new Map<string, string>();
  private files = new Map<string, string>();
  private terminals = new Set<string>();

  // Helper to seed file content for tests
  seedFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  async listWorkstreams(): Promise<Workstream[]> {
    return Array.from(this.workstreams.values());
  }

  async createWorkstream(name: string, directory: string): Promise<Workstream> {
    const ws: Workstream = {
      id: generateId(),
      name,
      description: null,
      directory,
      git_repo: null,
      git_branch: null,
      status: "active",
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

  async listDirectory(_path: string): Promise<string[]> {
    return Array.from(this.files.keys()).map((k) => `   ${k.split("/").pop() || k}`);
  }

  async detectGitInfo(_directory: string): Promise<{ repo: string | null; branch: string | null }> {
    return { repo: null, branch: null };
  }

  async spawnTerminal(tileId: string, _cwd: string, _command?: string, _rows?: number, _cols?: number): Promise<void> {
    this.terminals.add(tileId);
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
}
