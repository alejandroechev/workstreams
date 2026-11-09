//! Read Inbox entries expire (ADR 041).
//!
//! Every Inbox kind — PR events, pipeline runs, sync alerts, agent messages —
//! loses its read entries 5 days after they arrived. Unread ones stay. An
//! expired event leaves a content-free tombstone for 30 days so the poller
//! that reported it doesn't report it again as new.

use rusqlite::{params, Connection};

pub const KEEP_READ_DAYS: f64 = 5.0;
pub const TOMBSTONE_DAYS: f64 = 30.0;

/// The tombstone keys, one per insert path's own dedupe identity.
pub fn pr_key(
    project: &str,
    source: &str,
    identity: &str,
    pr_id: u64,
    kind: &str,
    dedupe: &str,
) -> String {
    format!("pr|{project}|{source}|{identity}|{pr_id}|{kind}|{dedupe}")
}
pub fn pipeline_key(watch: &str, run_id: u64, result: &str) -> String {
    format!("pipeline|{watch}|{run_id}|{result}")
}
pub fn sync_key(id: &str) -> String {
    format!("sync|{id}")
}

/// Whether an event with this key expired recently and must not come back.
pub fn tombstoned(db: &Connection, key: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM inbox_tombstones WHERE key=?1)",
        [key],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Deletes read entries older than 5 days as of `now` (ISO 8601), and
/// tombstones older than 30. Returns how many entries were deleted.
pub fn expire(db: &Connection, now: &str) -> Result<usize, String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let old = "julianday(created_at) < julianday(?1) - ?2";
    let run = |sql: &str| -> Result<usize, String> {
        tx.execute(sql, params![now, KEEP_READ_DAYS])
            .map_err(|e| e.to_string())
    };
    run(&format!(
        "INSERT OR REPLACE INTO inbox_tombstones (key, expired_at)
        SELECT 'pr|'||project_id||'|'||source||'|'||identity||'|'||pr_id||'|'||kind||'|'||dedupe_key, ?1
        FROM pr_inbox_events WHERE is_read=1 AND {old}"
    ))?;
    run(&format!(
        "INSERT OR REPLACE INTO inbox_tombstones (key, expired_at)
        SELECT 'pipeline|'||watch_id||'|'||run_id||'|'||result, ?1
        FROM pipeline_events WHERE is_read=1 AND {old}"
    ))?;
    // Sync alerts carry milliseconds since the epoch instead of created_at.
    let sync_old = "at < (julianday(?1) - 2440587.5 - ?2) * 86400000.0";
    run(&format!(
        "INSERT OR REPLACE INTO inbox_tombstones (key, expired_at)
        SELECT 'sync|'||id, ?1 FROM sync_events WHERE is_read=1 AND {sync_old}"
    ))?;
    let mut deleted = 0;
    deleted += run(&format!(
        "DELETE FROM pr_inbox_events WHERE is_read=1 AND {old}"
    ))?;
    deleted += run(&format!(
        "DELETE FROM pipeline_events WHERE is_read=1 AND {old}"
    ))?;
    deleted += run(&format!(
        "DELETE FROM sync_events WHERE is_read=1 AND {sync_old}"
    ))?;
    deleted += run(&format!(
        "DELETE FROM agent_messages WHERE is_read=1 AND {old}"
    ))?;
    tx.execute(
        "DELETE FROM pipeline_investigations WHERE event_id NOT IN (SELECT id FROM pipeline_events)",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM inbox_tombstones WHERE julianday(expired_at) < julianday(?1) - ?2",
        params![now, TOMBSTONE_DAYS],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(deleted)
}

fn expire_now(db: &Connection) -> Result<usize, String> {
    let now: String = db
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    expire(db, &now)
}

/// Runs the expiry at startup and then hourly, until dropped.
pub struct RetentionWorker {
    _stop: std::sync::mpsc::Sender<()>,
}

impl RetentionWorker {
    pub fn start(db: std::sync::Arc<std::sync::Mutex<Connection>>) -> Self {
        Self::start_every(db, std::time::Duration::from_secs(60 * 60))
    }

    fn start_every(
        db: std::sync::Arc<std::sync::Mutex<Connection>>,
        every: std::time::Duration,
    ) -> Self {
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || loop {
            if let Ok(conn) = db.lock() {
                if let Err(error) = expire_now(&conn) {
                    eprintln!("[inbox] Expiring read entries failed: {error}");
                }
            }
            // A message or a dropped sender (the app closing) ends it.
            if !matches!(
                stopped.recv_timeout(every),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                break;
            }
        });
        Self { _stop: stop }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-11-20T12:00:00Z";

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        conn
    }

    /// One entry of each kind: read 6 days old, read 4 days old, unread 30 days old.
    fn seed(db: &Connection) {
        for (n, (tag, read, at)) in [
            ("r6", 1, "2026-11-14T12:00:00Z"),
            ("r4", 1, "2026-11-16T12:00:00Z"),
            ("u30", 0, "2026-10-21T12:00:00Z"),
        ]
        .into_iter()
        .enumerate()
        {
            db.execute(
                "INSERT INTO pr_inbox_events (id,project_id,source,identity,pr_id,kind,title,author,summary,url,created_at,dedupe_key,is_read)
                VALUES (?1,'p','ado','me',7,'comment','T','A','S','u',?2,?1,?3)",
                params![format!("pr-{tag}"), at, read],
            )
            .unwrap();
            db.execute(
                "INSERT INTO pipeline_events (id,watch_id,run_id,run_number,result,branch,trigger_label,finished_at,created_at,is_read)
                VALUES (?1,'w',?4,'1','failed','main','S',?2,?2,?3)",
                params![format!("pl-{tag}"), at, read, n as i64 + 1],
            )
            .unwrap();
            let ms: i64 = db
                .query_row(
                    "SELECT CAST((julianday(?1) - 2440587.5) * 86400000 AS INTEGER)",
                    [at],
                    |r| r.get(0),
                )
                .unwrap();
            db.execute(
                "INSERT INTO sync_events (id,kind,event,at,message,hint,is_read) VALUES (?1,'down','x',?2,'m','h',?3)",
                params![format!("sy-{tag}"), ms, read],
            )
            .unwrap();
            db.execute(
                "INSERT INTO agent_messages (id,workstream_id,workstream_name,tile_id,level,title,body,is_read,created_at)
                VALUES (?1,'ws','Bench','t','done','T','',?3,?2)",
                params![format!("am-{tag}"), at, read],
            )
            .unwrap();
        }
    }

    fn ids(db: &Connection) -> Vec<String> {
        let mut all = Vec::new();
        for table in [
            "pr_inbox_events",
            "pipeline_events",
            "sync_events",
            "agent_messages",
        ] {
            let mut stmt = db
                .prepare(&format!("SELECT id FROM {table} ORDER BY id"))
                .unwrap();
            all.extend(
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .unwrap()
                    .map(Result::unwrap),
            );
        }
        all.sort();
        all
    }

    #[test]
    fn only_read_entries_older_than_five_days_expire_in_every_kind() {
        let db = db();
        seed(&db);
        db.execute(
            "INSERT INTO pipeline_investigations (event_id, workstream_id, prompt, created_at) VALUES ('pl-r6','ws','p','now'), ('pl-r4','ws','p','now')",
            [],
        )
        .unwrap();
        assert_eq!(expire(&db, NOW).unwrap(), 4);
        let left = ids(&db);
        assert!(left.iter().all(|id| !id.ends_with("-r6")), "{left:?}");
        assert_eq!(left.len(), 8);
        let investigations: Vec<String> = db
            .prepare("SELECT event_id FROM pipeline_investigations")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(investigations, vec!["pl-r4".to_string()]);
    }

    #[test]
    fn expired_events_are_tombstoned_for_thirty_days() {
        let db = db();
        seed(&db);
        expire(&db, NOW).unwrap();
        assert!(tombstoned(&db, &pr_key("p", "ado", "me", 7, "comment", "pr-r6")).unwrap());
        assert!(tombstoned(&db, &pipeline_key("w", 1, "failed")).unwrap());
        assert!(tombstoned(&db, &sync_key("sy-r6")).unwrap());
        assert!(!tombstoned(&db, &pr_key("p", "ado", "me", 7, "comment", "pr-r4")).unwrap());
        expire(&db, "2026-12-21T12:00:00Z").unwrap();
        assert!(
            !tombstoned(&db, &sync_key("sy-r6")).unwrap(),
            "purged after 30 days"
        );
    }

    #[test]
    fn the_worker_expires_at_start() {
        let shared = std::sync::Arc::new(std::sync::Mutex::new(db()));
        {
            let db = shared.lock().unwrap();
            db.execute(
                "INSERT INTO agent_messages (id,workstream_id,workstream_name,tile_id,level,title,body,is_read,created_at)
                VALUES ('old','ws','B','t','done','T','',1,'2000-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let _worker =
            RetentionWorker::start_every(shared.clone(), std::time::Duration::from_secs(3600));
        for _ in 0..100 {
            let left: i64 = shared
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM agent_messages", [], |r| r.get(0))
                .unwrap();
            if left == 0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("the worker never expired the old message");
    }
}
