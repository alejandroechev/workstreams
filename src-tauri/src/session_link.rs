//! Saving which Copilot session a tile runs (its link), natively.
//!
//! The session poller finds a new tile's session id. The link used to be saved
//! by the tile's UI, which only runs for the workstream on screen, so a session
//! started from the phone in a background workstream was never linked: it
//! couldn't be resumed or messaged. The poller now saves the link itself, for
//! every tile.

use crate::Tile;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

fn tile(db: &Connection, tile_id: &str) -> Result<Option<Tile>, String> {
    db.query_row(
        "SELECT id, workstream_id, tile_type, title, config_json, created_at, updated_at FROM tiles WHERE id = ?1",
        [tile_id],
        |r| {
            Ok(Tile {
                id: r.get(0)?,
                workstream_id: r.get(1)?,
                tile_type: r.get(2)?,
                title: r.get(3)?,
                config_json: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn linked_id(config: &Value) -> Option<&str> {
    config["copilot_session_id"]
        .as_str()
        .or_else(|| config["resume_by_id"].as_str())
        .filter(|s| !s.is_empty())
}

fn is_phone_tile(db: &Connection, tile_id: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT 1 FROM companion_sessions WHERE tile_id = ?1",
        [tile_id],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|e| e.to_string())
}

/// Session ids already linked to a tile anywhere.
pub fn linked_session_ids(db: &Connection) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = db
        .prepare("SELECT config_json FROM tiles WHERE tile_type = 'copilot_session'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = std::collections::HashSet::new();
    for raw in rows.flatten() {
        if let Ok(config) = serde_json::from_str::<Value>(&raw) {
            if let Some(id) = linked_id(&config) {
                out.insert(id.to_string());
            }
        }
    }
    Ok(out)
}

/// Links a tile to the session the poller found for it, unless it is linked
/// already. A laptop tile follows the one-linked-session-per-workstream rule
/// (another linked tile in its workstream means it stays unlinked); a tile
/// started from the phone is always linked, since the phone needs the link to
/// resume and message it. Returns the updated tile when it changed.
pub fn link_found_session(
    db: &Connection,
    tile_id: &str,
    session_id: &str,
    summary: Option<&str>,
    now: &str,
) -> Result<Option<Tile>, String> {
    let Some(mut tile) = tile(db, tile_id)? else {
        return Ok(None);
    };
    if tile.tile_type != "copilot_session" {
        return Ok(None);
    }
    let mut config: Value = serde_json::from_str(&tile.config_json)
        .unwrap_or_else(|_| Value::Object(Default::default()));
    if linked_id(&config).is_some() {
        return Ok(None);
    }
    if !is_phone_tile(db, tile_id)? {
        let mut stmt = db
            .prepare("SELECT config_json FROM tiles WHERE workstream_id = ?1 AND id <> ?2 AND tile_type = 'copilot_session'")
            .map_err(|e| e.to_string())?;
        let others: Vec<String> = stmt
            .query_map(params![tile.workstream_id, tile_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        let other_linked = others
            .iter()
            .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
            .any(|c| linked_id(&c).is_some());
        if other_linked {
            return Ok(None);
        }
    }
    if !config.is_object() {
        config = Value::Object(Default::default());
    }
    config["copilot_session_id"] = Value::from(session_id);
    config["resume_by_id"] = Value::from(session_id);
    config["is_resumed"] = Value::from(true);
    let summary = summary.map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = summary {
        config["session_name"] = Value::from(s);
        tile.title = Some(s.to_string());
    }
    tile.config_json = config.to_string();
    tile.updated_at = now.to_string();
    db.execute(
        "UPDATE tiles SET config_json = ?1, title = ?2, updated_at = ?3 WHERE id = ?4",
        params![tile.config_json, tile.title, tile.updated_at, tile.id],
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(tile))
}

/// Phone-started tiles left unlinked by earlier versions: each gets the
/// session that started in its folder within two minutes of the phone's
/// request, if one did. Returns the tiles it linked.
pub fn repair_phone_tiles(
    db: &Connection,
    home: &std::path::Path,
    now: &str,
) -> Result<Vec<Tile>, String> {
    let mut stmt = db
        .prepare(
            "SELECT t.id, t.config_json, cs.created_at FROM companion_sessions cs JOIN tiles t ON t.id = cs.tile_id \
             WHERE t.tile_type = 'copilot_session' ORDER BY cs.created_at",
        )
        .map_err(|e| e.to_string())?;
    let candidates: Vec<(String, String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    let mut taken = linked_session_ids(db)?;
    let mut linked = Vec::new();
    for (tile_id, raw, created_ms) in candidates {
        let Ok(config) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if linked_id(&config).is_some() {
            continue;
        }
        let Some(cwd) = config["cwd"].as_str() else {
            continue;
        };
        let created =
            std::time::UNIX_EPOCH + std::time::Duration::from_millis(created_ms.max(0) as u64);
        let after = created
            .checked_sub(std::time::Duration::from_secs(5))
            .unwrap_or(created);
        let Some(sid) = crate::session_poller::find_session_by_cwd(home, cwd, after, &taken) else {
            continue;
        };
        // Only a session that started right after the phone asked: a later
        // one in the same folder belongs to someone else.
        let started = std::fs::metadata(
            home.join(".copilot")
                .join("session-state")
                .join(&sid)
                .join("workspace.yaml"),
        )
        .and_then(|m| m.modified())
        .ok();
        if !started.is_some_and(|t| t <= created + std::time::Duration::from_secs(120)) {
            continue;
        }
        if let Some(tile) = link_found_session(db, &tile_id, &sid, None, now)? {
            taken.insert(sid);
            linked.push(tile);
        }
    }
    Ok(linked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        db.execute_batch(
            "INSERT INTO projects (id, name, directory, created_at, updated_at) VALUES ('p', 'P', '/tmp', 't', 't');
             INSERT INTO workstreams (id, project_id, name, directory, created_at, updated_at) VALUES ('w', 'p', 'W', '/tmp/w', 't', 't');",
        )
        .unwrap();
        db
    }

    fn add_tile(db: &Connection, id: &str, config: &str) {
        db.execute(
            "INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at) VALUES (?1, 'w', 'copilot_session', 'W/1', ?2, 't', 't')",
            params![id, config],
        )
        .unwrap();
    }

    fn phone(db: &Connection, tile_id: &str, created_ms: i64) {
        db.execute(
            "INSERT INTO companion_sessions (tile_id, workstream_id, request_id, prompt, created_at) VALUES (?1, 'w', 'r', 'p', ?2)",
            params![tile_id, created_ms],
        )
        .unwrap();
    }

    fn config_of(db: &Connection, id: &str) -> Value {
        serde_json::from_str(&tile(db, id).unwrap().unwrap().config_json).unwrap()
    }

    #[test]
    fn links_an_unlinked_tile_once_and_names_it() {
        let db = db();
        add_tile(&db, "a", r#"{"session_name":"W/1","cwd":"/tmp/w"}"#);
        let t = link_found_session(&db, "a", "sid-1", Some("Fix the bug"), "now")
            .unwrap()
            .unwrap();
        assert_eq!(t.title.as_deref(), Some("Fix the bug"));
        let c = config_of(&db, "a");
        assert_eq!(
            (
                c["copilot_session_id"].as_str(),
                c["resume_by_id"].as_str(),
                c["is_resumed"].as_bool()
            ),
            (Some("sid-1"), Some("sid-1"), Some(true))
        );
        assert_eq!(c["cwd"], "/tmp/w", "the rest of the config is kept");
        assert!(
            link_found_session(&db, "a", "sid-2", None, "now")
                .unwrap()
                .is_none(),
            "a linked tile keeps its session"
        );
        assert_eq!(config_of(&db, "a")["copilot_session_id"], "sid-1");
    }

    #[test]
    fn a_laptop_tile_keeps_one_linked_session_per_workstream_but_a_phone_tile_always_links() {
        let db = db();
        add_tile(&db, "linked", r#"{"copilot_session_id":"sid-0"}"#);
        add_tile(&db, "laptop", r#"{}"#);
        add_tile(&db, "phone", r#"{}"#);
        phone(&db, "phone", 0);
        assert!(link_found_session(&db, "laptop", "sid-1", None, "now")
            .unwrap()
            .is_none());
        assert!(link_found_session(&db, "phone", "sid-2", None, "now")
            .unwrap()
            .is_some());
        assert_eq!(config_of(&db, "phone")["copilot_session_id"], "sid-2");
        assert!(link_found_session(&db, "missing", "sid-3", None, "now")
            .unwrap()
            .is_none());
    }

    #[test]
    fn repairs_phone_tiles_left_unlinked_with_the_session_started_right_after() {
        let db = db();
        let home = std::env::temp_dir().join(format!("ws_link_repair_{}", std::process::id()));
        let root = home.join(".copilot").join("session-state");
        let session = |id: &str, cwd: &str| {
            std::fs::create_dir_all(root.join(id)).unwrap();
            std::fs::write(
                root.join(id).join("workspace.yaml"),
                format!("cwd: {cwd}\n"),
            )
            .unwrap();
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        session("sid-phone", "/tmp/phone-ws");
        session("sid-taken", "/tmp/other");
        add_tile(&db, "unlinked", r#"{"cwd":"/tmp/phone-ws"}"#);
        phone(&db, "unlinked", now_ms);
        add_tile(&db, "too-early", r#"{"cwd":"/tmp/other"}"#);
        phone(&db, "too-early", now_ms - 10 * 60_000);
        add_tile(&db, "laptop", r#"{"cwd":"/tmp/phone-ws"}"#);
        let linked = repair_phone_tiles(&db, &home, "now").unwrap();
        assert_eq!(
            linked.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["unlinked"]
        );
        assert_eq!(
            config_of(&db, "unlinked")["copilot_session_id"],
            "sid-phone"
        );
        assert!(
            linked_id(&config_of(&db, "too-early")).is_none(),
            "a session long after the request isn't its"
        );
        assert!(
            repair_phone_tiles(&db, &home, "now").unwrap().is_empty(),
            "idempotent"
        );
        std::fs::remove_dir_all(&home).ok();
    }
}
