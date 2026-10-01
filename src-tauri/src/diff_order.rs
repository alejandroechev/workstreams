//! Agent-recommended reading order for a Repo Explorer diff (ADR 032).
//!
//! The order itself comes from the workstream's agent; everything that makes it
//! trustworthy lives here: which diff it belongs to, the exact-file-set check,
//! and the two fingerprints that say whether the diff has moved on since.
//!
//! Fingerprints are always computed by the app from the same git queries the
//! diff view uses (`git_diff_files_with_status` / `git_diff_file_sides`), so the
//! saved order and the list on screen agree on what "the diff" is.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const MODES: [&str; 4] = [
    "unstaged",
    "last_commit",
    "branch_vs_master",
    "custom_branch",
];

/// Which diff an order belongs to. `target` is the Custom branch target and
/// empty for every other mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffKey {
    pub workstream_id: String,
    pub mode: String,
    pub target: String,
}

impl DiffKey {
    pub fn new(workstream_id: &str, mode: &str, target: Option<&str>) -> Result<Self, String> {
        if !MODES.contains(&mode) {
            return Err(format!(
                "Unknown diff mode {mode:?}; use one of {}",
                MODES.join(", ")
            ));
        }
        let target = target.map(str::trim).unwrap_or("");
        match (mode, target.is_empty()) {
            ("custom_branch", true) => {
                return Err("custom_branch needs target=<branch>".to_string());
            }
            (other, false) if other != "custom_branch" => {
                return Err(format!("{other} takes no target; only custom_branch does"));
            }
            _ => {}
        }
        Ok(Self {
            workstream_id: workstream_id.to_string(),
            mode: mode.to_string(),
            target: target.to_string(),
        })
    }

    fn base_ref(&self) -> Option<String> {
        (!self.target.is_empty()).then(|| self.target.clone())
    }
}

/// The diff as it is now, with both fingerprints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSnapshot {
    /// `(path, status)` exactly as the diff view lists them.
    pub files: Vec<(String, String)>,
    pub file_set_fingerprint: String,
    pub content_fingerprint: String,
}

pub fn snapshot(directory: &str, key: &DiffKey) -> Result<DiffSnapshot, String> {
    let mut files =
        crate::git_diff_files_with_status(directory.to_string(), key.mode.clone(), key.base_ref())?;
    files.sort();

    let mut file_set = Sha256::new();
    let mut content = Sha256::new();
    for (path, status) in &files {
        file_set.update(path.as_bytes());
        file_set.update([0]);
        file_set.update(status.as_bytes());
        file_set.update(b"\n");

        let (before, after) = crate::git_diff_file_sides(
            directory.to_string(),
            path.clone(),
            key.mode.clone(),
            key.base_ref(),
        )?;
        // Length-prefixed so no arrangement of contents can collide with another.
        for part in [path.as_str(), before.as_str(), after.as_str()] {
            content.update((part.len() as u64).to_le_bytes());
            content.update(part.as_bytes());
        }
    }
    Ok(DiffSnapshot {
        files,
        file_set_fingerprint: hex(file_set.finalize().as_slice()),
        content_fingerprint: hex(content.finalize().as_slice()),
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Why a proposed order is not exactly the diff's files.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct PathMismatch {
    pub unknown: Vec<String>,
    pub missing: Vec<String>,
    pub duplicates: Vec<String>,
}

pub fn check_paths(snapshot: &DiffSnapshot, paths: &[String]) -> Result<(), PathMismatch> {
    let known: std::collections::HashSet<&str> = snapshot
        .files
        .iter()
        .map(|(path, _)| path.as_str())
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut mismatch = PathMismatch::default();
    for path in paths {
        if !seen.insert(path.as_str()) {
            if !mismatch.duplicates.contains(path) {
                mismatch.duplicates.push(path.clone());
            }
        } else if !known.contains(path.as_str()) {
            mismatch.unknown.push(path.clone());
        }
    }
    mismatch.missing = snapshot
        .files
        .iter()
        .filter(|(path, _)| !seen.contains(path.as_str()))
        .map(|(path, _)| path.clone())
        .collect();
    if mismatch == PathMismatch::default() {
        Ok(())
    } else {
        Err(mismatch)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoredOrder {
    pub paths: Vec<String>,
    pub file_set_fingerprint: String,
    pub content_fingerprint: String,
    pub saved_at: String,
}

pub fn save(
    conn: &Connection,
    key: &DiffKey,
    paths: &[String],
    snapshot: &DiffSnapshot,
) -> Result<(), String> {
    let paths_json = serde_json::to_string(paths).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO diff_orders
           (workstream_id, mode, target, paths_json, file_set_fingerprint,
            content_fingerprint, saved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (workstream_id, mode, target) DO UPDATE SET
           paths_json = excluded.paths_json,
           file_set_fingerprint = excluded.file_set_fingerprint,
           content_fingerprint = excluded.content_fingerprint,
           saved_at = excluded.saved_at",
        rusqlite::params![
            key.workstream_id,
            key.mode,
            key.target,
            paths_json,
            snapshot.file_set_fingerprint,
            snapshot.content_fingerprint,
            crate::now(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load(conn: &Connection, key: &DiffKey) -> Result<Option<StoredOrder>, String> {
    let row = conn
        .query_row(
            "SELECT paths_json, file_set_fingerprint, content_fingerprint, saved_at
             FROM diff_orders WHERE workstream_id = ?1 AND mode = ?2 AND target = ?3",
            rusqlite::params![key.workstream_id, key.mode, key.target],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.map(
        |(paths_json, file_set_fingerprint, content_fingerprint, saved_at)| {
            Ok(StoredOrder {
                paths: serde_json::from_str(&paths_json).map_err(|e| e.to_string())?,
                file_set_fingerprint,
                content_fingerprint,
                saved_at,
            })
        },
    )
    .transpose()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Current,
    ContentChanged,
    FilesChanged,
}

pub fn freshness(stored: &StoredOrder, current: &DiffSnapshot) -> Freshness {
    if stored.file_set_fingerprint != current.file_set_fingerprint {
        Freshness::FilesChanged
    } else if stored.content_fingerprint != current.content_fingerprint {
        Freshness::ContentChanged
    } else {
        Freshness::Current
    }
}

/// What the diff view needs: the saved order and how far the diff has moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrderView {
    pub paths: Vec<String>,
    pub freshness: Freshness,
}

/// The order for the diff view, or `None` when nothing is saved. The diff is
/// only re-read when an order exists, so diffs nobody ordered cost nothing.
pub fn view(
    stored: Option<StoredOrder>,
    directory: &str,
    key: &DiffKey,
) -> Result<Option<OrderView>, String> {
    let Some(stored) = stored else {
        return Ok(None);
    };
    let current = snapshot(directory, key)?;
    Ok(Some(OrderView {
        freshness: freshness(&stored, &current),
        paths: stored.paths,
    }))
}

/// A throwaway git repository for tests that need a real diff.
#[cfg(test)]
pub(crate) mod test_repo {
    use std::path::PathBuf;

    pub struct Repo(pub PathBuf);

    impl Repo {
        pub fn new() -> Self {
            // The clock alone collides under parallel tests on macOS, where it
            // only has microsecond resolution.
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "ws-difforder-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = Repo(dir);
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.email", "t@t"]);
            repo.git(&["config", "user.name", "t"]);
            repo
        }
        pub fn git(&self, args: &[&str]) {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        pub fn write(&self, path: &str, body: &str) {
            let full = self.0.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
        }
        pub fn remove(&self, path: &str) {
            std::fs::remove_file(self.0.join(path)).unwrap();
        }
        pub fn dir(&self) -> &str {
            self.0.to_str().unwrap()
        }
        pub fn commit_all(&self, message: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", message]);
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff_order::test_repo::Repo;

    fn unstaged(ws: &str) -> DiffKey {
        DiffKey::new(ws, "unstaged", None).unwrap()
    }

    fn base_repo() -> Repo {
        let repo = Repo::new();
        repo.write("a.ts", "a1\n");
        repo.write("b.ts", "b1\n");
        repo.write("gone.ts", "g\n");
        repo.commit_all("init");
        repo
    }

    #[test]
    fn keys_accept_the_four_modes_and_need_a_target_only_for_custom_branch() {
        for mode in ["unstaged", "last_commit", "branch_vs_master"] {
            assert_eq!(DiffKey::new("w", mode, None).unwrap().target, "");
            assert!(
                DiffKey::new("w", mode, Some("main")).is_err(),
                "{mode} with a target"
            );
        }
        assert_eq!(
            DiffKey::new("w", "custom_branch", Some("main"))
                .unwrap()
                .target,
            "main"
        );
        assert!(DiffKey::new("w", "custom_branch", None).is_err());
        assert!(DiffKey::new("w", "custom_branch", Some("  ")).is_err());
        let err = DiffKey::new("w", "staged", None).unwrap_err();
        assert!(
            err.contains("unstaged") && err.contains("custom_branch"),
            "{err}"
        );
    }

    /// The fingerprint must cover exactly what the view lists, untracked and
    /// deleted files included, or every Unstaged order reads as stale.
    #[test]
    fn snapshot_lists_untracked_and_deleted_files_like_the_view() {
        let repo = base_repo();
        repo.write("a.ts", "a2\n");
        repo.write("new.ts", "n\n");
        repo.remove("gone.ts");
        let snap = snapshot(repo.dir(), &unstaged("w")).unwrap();
        assert_eq!(
            snap.files,
            vec![
                ("a.ts".to_string(), "M".to_string()),
                ("gone.ts".to_string(), "D".to_string()),
                ("new.ts".to_string(), "A".to_string()),
            ]
        );
        assert_eq!(snap.file_set_fingerprint.len(), 64);
        assert_eq!(snap.content_fingerprint.len(), 64);
    }

    #[test]
    fn content_edits_change_only_the_content_fingerprint() {
        let repo = base_repo();
        repo.write("a.ts", "a2\n");
        let first = snapshot(repo.dir(), &unstaged("w")).unwrap();
        assert_eq!(
            first,
            snapshot(repo.dir(), &unstaged("w")).unwrap(),
            "deterministic"
        );
        repo.write("a.ts", "a3\n");
        let edited = snapshot(repo.dir(), &unstaged("w")).unwrap();
        assert_eq!(edited.file_set_fingerprint, first.file_set_fingerprint);
        assert_ne!(edited.content_fingerprint, first.content_fingerprint);
        repo.write("b.ts", "b2\n");
        let widened = snapshot(repo.dir(), &unstaged("w")).unwrap();
        assert_ne!(widened.file_set_fingerprint, first.file_set_fingerprint);
    }

    #[test]
    fn snapshot_works_for_the_committed_modes() {
        let repo = base_repo();
        repo.git(&["branch", "-M", "main"]);
        repo.git(&["switch", "-q", "-c", "feature"]);
        repo.write("b.ts", "b2\n");
        repo.commit_all("change b");
        let last = snapshot(repo.dir(), &DiffKey::new("w", "last_commit", None).unwrap()).unwrap();
        assert_eq!(last.files, vec![("b.ts".to_string(), "M".to_string())]);
        let branch = snapshot(
            repo.dir(),
            &DiffKey::new("w", "custom_branch", Some("main")).unwrap(),
        )
        .unwrap();
        assert_eq!(branch.files, last.files);
    }

    #[test]
    fn a_proposed_order_must_be_exactly_the_diff_files() {
        let snap = DiffSnapshot {
            files: vec![
                ("a.ts".into(), "M".into()),
                ("b.ts".into(), "M".into()),
                ("c.ts".into(), "A".into()),
            ],
            file_set_fingerprint: String::new(),
            content_fingerprint: String::new(),
        };
        let owned = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            check_paths(&snap, &owned(&["c.ts", "a.ts", "b.ts"])),
            Ok(())
        );
        assert_eq!(
            check_paths(&snap, &owned(&["a.ts", "b.ts", "z.ts", "a.ts"])),
            Err(PathMismatch {
                unknown: owned(&["z.ts"]),
                missing: owned(&["c.ts"]),
                duplicates: owned(&["a.ts"]),
            })
        );
    }

    fn db_with_workstream() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w', 'W', 'x', 'x')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn saved_orders_round_trip_and_the_latest_wins() {
        let conn = db_with_workstream();
        let key = unstaged("w");
        assert_eq!(load(&conn, &key).unwrap(), None);
        let snap = DiffSnapshot {
            files: vec![],
            file_set_fingerprint: "f1".into(),
            content_fingerprint: "c1".into(),
        };
        save(&conn, &key, &["b".into(), "a".into()], &snap).unwrap();
        let mut newer = snap.clone();
        newer.content_fingerprint = "c2".into();
        save(&conn, &key, &["a".into(), "b".into()], &newer).unwrap();
        let stored = load(&conn, &key).unwrap().unwrap();
        assert_eq!(stored.paths, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(stored.content_fingerprint, "c2");
        assert!(!stored.saved_at.is_empty());
        let other = DiffKey::new("w", "last_commit", None).unwrap();
        assert_eq!(load(&conn, &other).unwrap(), None, "modes are independent");
    }

    #[test]
    fn the_view_reads_the_diff_only_when_an_order_exists() {
        // A directory that is not a repo would fail any git call.
        let nowhere = std::env::temp_dir().join("ws-difforder-not-a-repo");
        let key = unstaged("w");
        assert_eq!(view(None, nowhere.to_str().unwrap(), &key).unwrap(), None);

        let repo = base_repo();
        repo.write("a.ts", "a2\n");
        let snap = snapshot(repo.dir(), &key).unwrap();
        let stored = StoredOrder {
            paths: vec!["a.ts".into()],
            file_set_fingerprint: snap.file_set_fingerprint.clone(),
            content_fingerprint: snap.content_fingerprint.clone(),
            saved_at: "now".into(),
        };
        assert_eq!(
            view(Some(stored.clone()), repo.dir(), &key).unwrap(),
            Some(OrderView {
                paths: vec!["a.ts".into()],
                freshness: Freshness::Current
            })
        );
        repo.write("b.ts", "b2\n");
        assert_eq!(
            view(Some(stored), repo.dir(), &key)
                .unwrap()
                .unwrap()
                .freshness,
            Freshness::FilesChanged
        );
    }

    #[test]
    fn freshness_separates_content_drift_from_file_drift() {
        let stored = StoredOrder {
            paths: vec![],
            file_set_fingerprint: "f".into(),
            content_fingerprint: "c".into(),
            saved_at: "now".into(),
        };
        let now = |f: &str, c: &str| DiffSnapshot {
            files: vec![],
            file_set_fingerprint: f.into(),
            content_fingerprint: c.into(),
        };
        assert_eq!(freshness(&stored, &now("f", "c")), Freshness::Current);
        assert_eq!(
            freshness(&stored, &now("f", "x")),
            Freshness::ContentChanged
        );
        assert_eq!(freshness(&stored, &now("x", "x")), Freshness::FilesChanged);
    }
}
