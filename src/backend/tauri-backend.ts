import { invoke } from "@tauri-apps/api/core";
import type { Project, Workstream, Tile, TileType, WorkstreamLayout, CopilotConfigItem } from "../domain/types";
import type { Backend } from "./types";

export class TauriBackend implements Backend {
  async listProjects(): Promise<Project[]> {
    return invoke<Project[]>("list_projects");
  }

  async createProject(name: string, directory: string, color?: string): Promise<Project> {
    return invoke<Project>("create_project", { name, directory, color });
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<void> {
    await invoke("update_project", { id, ...updates });
  }

  async deleteProject(id: string): Promise<void> {
    await invoke("delete_project", { id });
  }

  async listWorkstreams(): Promise<Workstream[]> {
    return invoke<Workstream[]>("list_workstreams");
  }

  async createWorkstream(name: string, directory: string, opts?: { projectId?: string; workstreamType?: string; worktreeBranch?: string }): Promise<Workstream> {
    return invoke<Workstream>("create_workstream", {
      name,
      directory,
      projectId: opts?.projectId,
      workstreamType: opts?.workstreamType,
      worktreeBranch: opts?.worktreeBranch,
    });
  }

  async updateWorkstream(id: string, updates: Partial<Workstream>): Promise<void> {
    await invoke("update_workstream", { id, ...updates });
  }

  async deleteWorkstream(id: string): Promise<void> {
    await invoke("delete_workstream", { id });
  }

  async listTiles(workstreamId: string): Promise<Tile[]> {
    return invoke<Tile[]>("list_tiles", { workstreamId });
  }

  async createTile(workstreamId: string, tileType: TileType, title: string, configJson: string): Promise<Tile> {
    return invoke<Tile>("create_tile", { workstreamId, tileType, title, configJson });
  }

  async deleteTile(tileId: string): Promise<void> {
    await invoke("delete_tile", { tileId });
  }

  async updateTileConfig(id: string, configJson: string, title?: string): Promise<void> {
    await invoke("update_tile_config", { tileId: id, configJson, title });
  }

  async getLayout(workstreamId: string): Promise<WorkstreamLayout> {
    return invoke<WorkstreamLayout>("get_layout", { workstreamId });
  }

  async updateLayout(workstreamId: string, updates: Partial<WorkstreamLayout>): Promise<void> {
    await invoke("update_layout", {
      workstreamId,
      ...(updates.tile_order_json !== undefined ? { tileOrderJson: updates.tile_order_json } : {}),
      ...(updates.fullscreen_tile_id !== undefined ? { fullscreenTileId: updates.fullscreen_tile_id } : {}),
      ...(updates.focused_tile_id !== undefined ? { focusedTileId: updates.focused_tile_id } : {}),
      ...(updates.layout_mode !== undefined ? { layoutMode: updates.layout_mode } : {}),
    });
  }

  async readFile(path: string): Promise<string> {
    return invoke<string>("read_file", { path });
  }

  async listDirectory(path: string): Promise<Array<{ name: string; is_dir: boolean; modified_epoch: number }>> {
    return invoke<Array<{ name: string; is_dir: boolean; modified_epoch: number }>>("list_directory", { path });
  }

  async detectGitInfo(directory: string): Promise<{ repo: string | null; branch: string | null }> {
    const [repo, branch] = await invoke<[string | null, string | null]>("detect_git_info", { directory });
    return { repo, branch };
  }

  async spawnTerminal(tileId: string, cwd: string, command?: string, args?: string[], rows?: number, cols?: number): Promise<void> {
    await invoke("spawn_terminal", {
      tileId,
      cwd,
      command: command ?? null,
      args: args ?? null,
      rows: rows ?? 30,
      cols: cols ?? 120,
    });
  }

  async spawnCopilotSession(tileId: string, cwd: string, resumeSessionId?: string | null, rows?: number, cols?: number): Promise<number | null> {
    const pid = await invoke<number | null>("spawn_copilot_session", {
      tileId,
      cwd,
      resumeSessionId: resumeSessionId ?? null,
      rows: rows ?? 30,
      cols: cols ?? 120,
    });
    return pid ?? null;
  }

  async writeToTerminal(tileId: string, data: string): Promise<void> {
    await invoke("write_to_pty", { tileId, data });
  }

  async resizeTerminal(tileId: string, rows: number, cols: number): Promise<void> {
    await invoke("resize_pty", { tileId, rows, cols });
  }

  async closeTerminal(tileId: string): Promise<void> {
    await invoke("close_terminal", { tileId });
  }

  async saveScrollback(tileId: string, scrollback: string): Promise<void> {
    await invoke("save_scrollback", { tileId, scrollback });
  }

  async loadScrollback(tileId: string): Promise<string | null> {
    return invoke<string | null>("load_scrollback", { tileId });
  }

  async watchSession(tileId: string, sessionName: string): Promise<void> {
    await invoke("watch_session", { tileId, sessionName });
  }

  async unwatchSession(tileId: string): Promise<void> {
    await invoke("unwatch_session", { tileId });
  }

  async searchFiles(directory: string, query: string): Promise<string[]> {
    return invoke<string[]>("search_files", { directory, query });
  }

  async searchInFiles(directory: string, query: string, limit?: number): Promise<import("./types").FileSearchMatch[]> {
    return invoke<import("./types").FileSearchMatch[]>("search_in_files", { directory, query, limit });
  }

  async gitDiffFiles(directory: string, mode: string): Promise<string[]> {
    return invoke<string[]>("git_diff_files", { directory, mode });
  }

  async gitDiffFile(directory: string, filePath: string, mode: string): Promise<string> {
    return invoke<string>("git_diff_file", { directory, filePath, mode });
  }

  async gitLog(directory: string, limit?: number): Promise<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>> {
    return invoke<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>>("git_log", { directory, limit: limit ?? null });
  }

  async gitShowCommit(directory: string, hash: string): Promise<string> {
    return invoke<string>("git_show_commit", { directory, hash });
  }

  async gitCurrentBranch(directory: string): Promise<string> {
    return invoke<string>("git_current_branch", { directory });
  }

  async discoverCopilotConfig(workstreamDir?: string): Promise<CopilotConfigItem[]> {
    return invoke<CopilotConfigItem[]>("discover_copilot_config", { workstreamDir: workstreamDir ?? null });
  }
}
