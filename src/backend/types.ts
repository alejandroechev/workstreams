import type { Workstream, Tile, TileType, WorkstreamLayout } from "../domain/types";

export interface Backend {
  // Workstreams
  listWorkstreams(): Promise<Workstream[]>;
  createWorkstream(name: string, directory: string): Promise<Workstream>;
  updateWorkstream(id: string, updates: Partial<Workstream>): Promise<void>;
  deleteWorkstream(id: string): Promise<void>;
  // Tiles
  listTiles(workstreamId: string): Promise<Tile[]>;
  createTile(workstreamId: string, type: TileType, title: string, config: string): Promise<Tile>;
  deleteTile(id: string): Promise<void>;
  // Layout
  getLayout(workstreamId: string): Promise<WorkstreamLayout>;
  updateLayout(workstreamId: string, updates: Partial<WorkstreamLayout>): Promise<void>;
  // Files
  readFile(path: string): Promise<string>;
  listDirectory(path: string): Promise<string[]>;
  detectGitInfo(directory: string): Promise<{ repo: string | null; branch: string | null }>;
  // PTY
  spawnTerminal(tileId: string, cwd: string, command?: string, rows?: number, cols?: number): Promise<void>;
  writeToTerminal(tileId: string, data: string): Promise<void>;
  resizeTerminal(tileId: string, rows: number, cols: number): Promise<void>;
  closeTerminal(tileId: string): Promise<void>;
  // Scrollback
  saveScrollback(tileId: string, data: string): Promise<void>;
  loadScrollback(tileId: string): Promise<string | null>;
}
