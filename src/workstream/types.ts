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
  tile_type: "terminal" | "code_viewer" | "doc_viewer";
  title: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface TerminalConfig {
  command?: string;
  cwd?: string;
  shell?: string;
  process_pid?: number | null;
  process_status?: "spawning" | "running" | "exited" | "failed";
  exit_code?: number | null;
}

export interface WorkstreamLayout {
  workstream_id: string;
  layout_mode: string;
  focused_tile_id: string | null;
  fullscreen_tile_id: string | null;
  tile_order_json: string;
  updated_at: string;
}
