// @test-skip: type-only module
/** A Diagram tile board as stored (ADR 043). `scene_json` is `{elements, files}`. */
export interface DiagramBoard {
  id: string;
  tile_id: string;
  name: string;
  position: number;
  scene_json: string;
  updated_at: string;
}

/** Mermaid an agent queued for a board; the open tile converts it into shapes. */
export interface DiagramAddition {
  id: string;
  board_id: string;
  mermaid: string;
  status: "pending" | "failed";
  error: string | null;
  created_at: string;
}
