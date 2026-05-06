export interface Workstream {
  id: string;
  name: string;
  description: string | null;
  directory: string | null;
  git_repo: string | null;
  git_branch: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Tile {
  id: string;
  workstream_id: string;
  tile_type: TileType;
  title: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export type TileType = "terminal" | "copilot_session" | "file_viewer" | "file_explorer" | "code_viewer" | "doc_viewer";

export interface TerminalConfig {
  command?: string;
  cwd?: string;
  shell?: string;
  process_pid?: number | null;
  process_status?: "spawning" | "running" | "exited" | "failed";
  exit_code?: number | null;
}

export interface CopilotSessionConfig {
  session_name: string;
  copilot_session_id?: string | null;
  command_template: string;
  cwd: string;
  is_resumed: boolean;
  created_at: string;
}

export interface CopilotSessionStats {
  context_percent?: number | null;
  turn_count?: number | null;
  summary?: string | null;
  last_activity?: string | null;
  duration_minutes?: number | null;
}

export interface WorkstreamLayout {
  workstream_id: string;
  layout_mode: string;
  focused_tile_id: string | null;
  fullscreen_tile_id: string | null;
  tile_order_json: string;
  updated_at: string;
}

export interface GridConfig {
  columns: string;
  rows: string;
  areas: string;
}

export type Direction = "left" | "right" | "up" | "down";
