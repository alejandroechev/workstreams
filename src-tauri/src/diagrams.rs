//! Diagram tile boards (ADR 043).
//!
//! A Diagram tile holds several named boards. Each board's scene (Excalidraw
//! elements plus image files) is stored here, never in the workstream folder,
//! until the user saves one to a file.
//!
//! Agents add to a board through `diagram.add`, which only queues Mermaid text:
//! converting Mermaid into shapes needs Mermaid's browser renderer, so the
//! frontend converts each queued addition when the board's tile is open and
//! then resolves it. Additions append shapes; they never touch existing ones.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const EMPTY_SCENE: &str = r#"{"elements":[],"files":{}}"#;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Board {
    pub id: String,
    pub tile_id: String,
    pub name: String,
    pub position: i64,
    pub scene_json: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Addition {
    pub id: String,
    pub board_id: String,
    pub mermaid: String,
    /// `pending` until the frontend converts it, then removed; `failed` keeps
    /// the parse error so the agent can see why nothing was drawn.
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

fn board_from_row(row: &rusqlite::Row) -> rusqlite::Result<Board> {
    Ok(Board {
        id: row.get(0)?,
        tile_id: row.get(1)?,
        name: row.get(2)?,
        position: row.get(3)?,
        scene_json: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

const BOARD_COLUMNS: &str = "id, tile_id, name, position, scene_json, updated_at";

pub fn list_boards(conn: &Connection, tile_id: &str) -> Result<Vec<Board>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {BOARD_COLUMNS} FROM diagram_boards WHERE tile_id = ?1 ORDER BY position, created_at"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([tile_id], board_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn get_board(conn: &Connection, id: &str) -> Result<Option<Board>, String> {
    conn.query_row(
        &format!("SELECT {BOARD_COLUMNS} FROM diagram_boards WHERE id = ?1"),
        [id],
        board_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn create_board(
    conn: &Connection,
    id: &str,
    tile_id: &str,
    name: &str,
    now: &str,
) -> Result<Board, String> {
    let name = clean_name(name)?;
    let position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM diagram_boards WHERE tile_id = ?1",
            [tile_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO diagram_boards (id, tile_id, name, position, scene_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, tile_id, name, position, EMPTY_SCENE, now],
    )
    .map_err(|e| e.to_string())?;
    get_board(conn, id)?.ok_or_else(|| "board vanished after insert".to_string())
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A board needs a name".to_string());
    }
    Ok(name.chars().take(80).collect())
}

pub fn rename_board(conn: &Connection, id: &str, name: &str, now: &str) -> Result<(), String> {
    let name = clean_name(name)?;
    let n = conn
        .execute(
            "UPDATE diagram_boards SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("No board {id}"));
    }
    Ok(())
}

pub fn delete_board(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM diagram_boards WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_scene(conn: &Connection, id: &str, scene_json: &str, now: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(scene_json)
        .map_err(|e| format!("Scene is not JSON: {e}"))?;
    let n = conn
        .execute(
            "UPDATE diagram_boards SET scene_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, scene_json, now],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("No board {id}"));
    }
    Ok(())
}

pub fn queue_addition(
    conn: &Connection,
    id: &str,
    board_id: &str,
    mermaid: &str,
    now: &str,
) -> Result<Addition, String> {
    if mermaid.trim().is_empty() {
        return Err("The Mermaid text is empty".to_string());
    }
    conn.execute(
        "INSERT INTO diagram_additions (id, board_id, mermaid, status, created_at)
         VALUES (?1, ?2, ?3, 'pending', ?4)",
        params![id, board_id, mermaid, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(Addition {
        id: id.to_string(),
        board_id: board_id.to_string(),
        mermaid: mermaid.to_string(),
        status: "pending".to_string(),
        error: None,
        created_at: now.to_string(),
    })
}

pub fn additions(conn: &Connection, board_id: &str) -> Result<Vec<Addition>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, board_id, mermaid, status, error, created_at FROM diagram_additions
             WHERE board_id = ?1 ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([board_id], |row| {
            Ok(Addition {
                id: row.get(0)?,
                board_id: row.get(1)?,
                mermaid: row.get(2)?,
                status: row.get(3)?,
                error: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Applied additions disappear (they are now shapes); failed ones keep their error.
pub fn resolve_addition(conn: &Connection, id: &str, error: Option<&str>) -> Result<(), String> {
    match error {
        None => conn.execute("DELETE FROM diagram_additions WHERE id = ?1", [id]),
        Some(message) => conn.execute(
            "UPDATE diagram_additions SET status = 'failed', error = ?2 WHERE id = ?1",
            params![id, message],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BoardRef {
    pub id: String,
    pub name: String,
    pub tile_id: String,
    pub tile_title: Option<String>,
}

/// Every board of every Diagram tile in a workstream, in tile then board order.
pub fn workstream_boards(conn: &Connection, workstream_id: &str) -> Result<Vec<BoardRef>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.name, b.tile_id, t.title FROM diagram_boards b
             JOIN tiles t ON t.id = b.tile_id
             WHERE t.workstream_id = ?1
             ORDER BY t.created_at, b.position, b.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workstream_id], |row| {
            Ok(BoardRef {
                id: row.get(0)?,
                name: row.get(1)?,
                tile_id: row.get(2)?,
                tile_title: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Resolves `board=` (an id, or a name unique within the workstream).
pub fn find_board(conn: &Connection, workstream_id: &str, board: &str) -> Result<BoardRef, String> {
    let boards = workstream_boards(conn, workstream_id)?;
    if let Some(found) = boards.iter().find(|b| b.id == board) {
        return Ok(found.clone());
    }
    let named: Vec<&BoardRef> = boards
        .iter()
        .filter(|b| b.name.eq_ignore_ascii_case(board.trim()))
        .collect();
    match named.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!("No diagram board {board:?} in this workstream")),
        _ => Err(format!(
            "{} boards are named {board:?}; use the board id",
            named.len()
        )),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Shape {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Link {
    pub from: Option<String>,
    pub to: Option<String>,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Summary {
    pub shapes: Vec<Shape>,
    pub connections: Vec<Link>,
    pub images: usize,
}

/// Reads a scene as labelled shapes and labelled connections (arrows between
/// shapes), which is what an agent needs to use a sketch as context.
pub fn summarize(scene_json: &str) -> Summary {
    let scene: serde_json::Value = serde_json::from_str(scene_json).unwrap_or_default();
    let empty = Vec::new();
    let elements: Vec<&serde_json::Value> = scene
        .get("elements")
        .and_then(|e| e.as_array())
        .unwrap_or(&empty)
        .iter()
        .filter(|e| {
            !e.get("isDeleted")
                .and_then(|d| d.as_bool())
                .unwrap_or(false)
        })
        .collect();
    let str_of = |e: &serde_json::Value, key: &str| {
        e.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let text_of = |e: &serde_json::Value| {
        let t = str_of(e, "originalText");
        if t.is_empty() {
            str_of(e, "text")
        } else {
            t
        }
    };
    let mut labels = std::collections::HashMap::new();
    for e in &elements {
        if str_of(e, "type") == "text" {
            let container = str_of(e, "containerId");
            if !container.is_empty() {
                labels.insert(container, text_of(e).replace('\n', " "));
            }
        }
    }
    let label_for = |id: &str| labels.get(id).cloned().unwrap_or_default();
    let mut shapes = Vec::new();
    let mut connections = Vec::new();
    let mut images = 0;
    for e in &elements {
        let kind = str_of(e, "type");
        let id = str_of(e, "id");
        match kind.as_str() {
            "arrow" => {
                let end = |key: &str| {
                    e.get(key)
                        .and_then(|b| b.get("elementId"))
                        .and_then(|v| v.as_str())
                        .map(|target| {
                            let label = label_for(target);
                            if label.is_empty() {
                                target.to_string()
                            } else {
                                label
                            }
                        })
                };
                connections.push(Link {
                    from: end("startBinding"),
                    to: end("endBinding"),
                    label: label_for(&id),
                });
            }
            "text" if !str_of(e, "containerId").is_empty() => {}
            "text" => shapes.push(Shape {
                id,
                kind,
                label: text_of(e).replace('\n', " "),
            }),
            "image" => images += 1,
            _ => {
                let label = label_for(&id);
                shapes.push(Shape { id, kind, label });
            }
        }
    }
    Summary {
        shapes,
        connections,
        images,
    }
}

/// The summary as short readable text, one line per shape or connection.
pub fn summary_text(name: &str, summary: &Summary, pending: usize, failed: &[Addition]) -> String {
    let mut out = format!(
        "Board \"{name}\": {} shapes, {} connections",
        summary.shapes.len(),
        summary.connections.len()
    );
    if summary.images > 0 {
        out.push_str(&format!(", {} images", summary.images));
    }
    out.push('\n');
    for s in &summary.shapes {
        if s.label.is_empty() {
            out.push_str(&format!("- {}\n", s.kind));
        } else {
            out.push_str(&format!("- {} \"{}\"\n", s.kind, s.label));
        }
    }
    for c in &summary.connections {
        let side = |v: &Option<String>| {
            v.clone()
                .map(|l| format!("\"{l}\""))
                .unwrap_or_else(|| "(loose end)".to_string())
        };
        out.push_str(&format!("- {} -> {}", side(&c.from), side(&c.to)));
        if !c.label.is_empty() {
            out.push_str(&format!(" \"{}\"", c.label));
        }
        out.push('\n');
    }
    if pending > 0 {
        out.push_str(&format!(
            "{pending} addition(s) pending: drawn when the Diagram tile is next open\n"
        ));
    }
    for f in failed {
        out.push_str(&format!(
            "Addition {} failed: {}\n",
            f.id,
            f.error.clone().unwrap_or_default()
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workstreams (id, name, directory, created_at, updated_at) VALUES ('w1','W','/w','t','t');
             INSERT INTO tiles (id, workstream_id, tile_type, title, created_at, updated_at) VALUES ('t1','w1','diagram','Diagram 1','t','t');
             INSERT INTO tiles (id, workstream_id, tile_type, created_at, updated_at) VALUES ('t2','w1','diagram','t','t');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn boards_are_created_in_order_renamed_saved_and_deleted() {
        let conn = db();
        create_board(&conn, "b1", "t1", "Board 1", "1").unwrap();
        create_board(&conn, "b2", "t1", "  Ideas ", "2").unwrap();
        let boards = list_boards(&conn, "t1").unwrap();
        assert_eq!(
            boards
                .iter()
                .map(|b| (b.name.as_str(), b.position))
                .collect::<Vec<_>>(),
            vec![("Board 1", 0), ("Ideas", 1)]
        );
        assert_eq!(boards[0].scene_json, EMPTY_SCENE);

        rename_board(&conn, "b1", "Flow", "3").unwrap();
        save_scene(&conn, "b1", r#"{"elements":[{"id":"x"}],"files":{}}"#, "4").unwrap();
        let b1 = get_board(&conn, "b1").unwrap().unwrap();
        assert_eq!((b1.name.as_str(), b1.updated_at.as_str()), ("Flow", "4"));
        assert!(b1.scene_json.contains("\"x\""));

        assert!(rename_board(&conn, "b1", "   ", "5").is_err());
        assert!(save_scene(&conn, "b1", "not json", "5").is_err());
        assert!(save_scene(&conn, "nope", EMPTY_SCENE, "5").is_err());

        delete_board(&conn, "b2").unwrap();
        assert_eq!(list_boards(&conn, "t1").unwrap().len(), 1);
    }

    #[test]
    fn deleting_the_tile_deletes_its_boards_and_their_additions() {
        let conn = db();
        create_board(&conn, "b1", "t1", "Board 1", "1").unwrap();
        queue_addition(&conn, "a1", "b1", "flowchart LR\nA-->B", "2").unwrap();
        conn.execute("DELETE FROM tiles WHERE id = 't1'", [])
            .unwrap();
        assert!(list_boards(&conn, "t1").unwrap().is_empty());
        assert!(additions(&conn, "b1").unwrap().is_empty());
    }

    #[test]
    fn additions_queue_then_resolve_by_disappearing_or_keeping_the_error() {
        let conn = db();
        create_board(&conn, "b1", "t1", "Board 1", "1").unwrap();
        assert!(queue_addition(&conn, "a0", "b1", "  ", "1").is_err());
        queue_addition(&conn, "a1", "b1", "flowchart LR\nA-->B", "2").unwrap();
        queue_addition(&conn, "a2", "b1", "nonsense", "3").unwrap();
        assert_eq!(additions(&conn, "b1").unwrap().len(), 2);
        resolve_addition(&conn, "a1", None).unwrap();
        resolve_addition(&conn, "a2", Some("Parse error on line 1")).unwrap();
        let left = additions(&conn, "b1").unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].status, "failed");
        assert_eq!(left[0].error.as_deref(), Some("Parse error on line 1"));
    }

    #[test]
    fn boards_are_found_by_id_or_unique_name_within_the_workstream() {
        let conn = db();
        create_board(&conn, "b1", "t1", "Flow", "1").unwrap();
        create_board(&conn, "b2", "t2", "Ideas", "2").unwrap();
        create_board(&conn, "b3", "t2", "ideas", "3").unwrap();
        assert_eq!(workstream_boards(&conn, "w1").unwrap().len(), 3);
        assert_eq!(find_board(&conn, "w1", "b2").unwrap().id, "b2");
        assert_eq!(find_board(&conn, "w1", "flow").unwrap().id, "b1");
        assert!(find_board(&conn, "w1", "Ideas")
            .unwrap_err()
            .contains("use the board id"));
        assert!(find_board(&conn, "w1", "Nope").is_err());
        assert!(find_board(&conn, "other", "b1").is_err());
    }

    #[test]
    fn a_scene_reads_as_labelled_shapes_and_connections() {
        let scene = r#"{"elements":[
          {"id":"a","type":"rectangle"},
          {"id":"ta","type":"text","containerId":"a","text":"API","originalText":"API"},
          {"id":"b","type":"ellipse"},
          {"id":"tb","type":"text","containerId":"b","text":"DB"},
          {"id":"r","type":"arrow","startBinding":{"elementId":"a"},"endBinding":{"elementId":"b"}},
          {"id":"tr","type":"text","containerId":"r","text":"reads"},
          {"id":"loose","type":"arrow","startBinding":{"elementId":"b"}},
          {"id":"n","type":"text","text":"a note"},
          {"id":"gone","type":"rectangle","isDeleted":true},
          {"id":"img","type":"image"}
        ],"files":{}}"#;
        let s = summarize(scene);
        assert_eq!(
            s.shapes
                .iter()
                .map(|x| (x.kind.as_str(), x.label.as_str()))
                .collect::<Vec<_>>(),
            vec![("rectangle", "API"), ("ellipse", "DB"), ("text", "a note")]
        );
        assert_eq!(
            s.connections[0],
            Link {
                from: Some("API".into()),
                to: Some("DB".into()),
                label: "reads".into()
            }
        );
        assert_eq!(s.connections[1].to, None);
        assert_eq!(s.images, 1);
        let text = summary_text("Flow", &s, 1, &[]);
        assert!(text.starts_with("Board \"Flow\": 3 shapes, 2 connections, 1 images"));
        assert!(text.contains("- \"API\" -> \"DB\" \"reads\""));
        assert!(text.contains("- \"DB\" -> (loose end)"));
        assert!(text.contains("1 addition(s) pending"));
        assert_eq!(summarize("garbage").shapes.len(), 0);
    }
}
