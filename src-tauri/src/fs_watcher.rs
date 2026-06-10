use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FsChangeEvent {
    pub path: String,
    pub kind: String, // "any" — debouncer collapses event types
}

pub struct FsWatcher {
    watched_paths: Mutex<HashSet<String>>,
    _watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
}

/// Returns true when a changed path is inside a directory we should ignore
/// for fs-change broadcasts (build artifacts, dependency dumps, git
/// internals). Pure helper, unit-tested below.
///
/// Match semantics: the path is split on Windows/Unix separators and any
/// segment matching one of the exclude names triggers the filter. This
/// catches both top-level `./node_modules/foo.js` and nested
/// `./packages/x/node_modules/y.js`.
pub fn is_excluded_path(path: &str) -> bool {
    const EXCLUDED_SEGMENTS: &[&str] = &[
        "node_modules",
        ".git",
        "target",
        "dist",
        ".next",
        ".turbo",
        ".dev",
    ];
    for segment in path.split(['\\', '/']) {
        if EXCLUDED_SEGMENTS.contains(&segment) {
            return true;
        }
    }
    false
}

impl FsWatcher {
    pub fn new() -> Self {
        Self {
            watched_paths: Mutex::new(HashSet::new()),
            _watcher: Mutex::new(None),
        }
    }

    /// Start the filesystem watcher with a Tauri app handle for emitting events
    pub fn start(&self, app: AppHandle) {
        let app_handle = app.clone();
        let debouncer = new_debouncer(
            Duration::from_millis(500),
            move |events: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
                match events {
                    Ok(events) => {
                        let mut seen = HashSet::new();
                        for event in events {
                            if event.kind == DebouncedEventKind::Any {
                                let path_str = event.path.to_string_lossy().to_string();
                                // Skip fan-out from build artifacts / deps —
                                // see is_excluded_path.
                                if is_excluded_path(&path_str) {
                                    continue;
                                }
                                if seen.insert(path_str.clone()) {
                                    let _ = app_handle.emit(
                                        "fs-change",
                                        FsChangeEvent {
                                            path: path_str,
                                            kind: "any".into(),
                                        },
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[FsWatcher] error: {e:?}");
                    }
                }
            },
        );

        match debouncer {
            Ok(d) => {
                *self._watcher.lock().unwrap() = Some(d);
            }
            Err(e) => {
                eprintln!("[FsWatcher] failed to create watcher: {e:?}");
            }
        }
    }

    /// Watch a directory (recursive)
    pub fn watch(&self, path: &str) -> Result<(), String> {
        let mut watcher_guard = self._watcher.lock().unwrap();
        let watcher = watcher_guard.as_mut().ok_or("FsWatcher not started")?;

        let pb = PathBuf::from(path);
        if !pb.exists() {
            return Err(format!("Path does not exist: {path}"));
        }

        watcher
            .watcher()
            .watch(&pb, notify::RecursiveMode::Recursive)
            .map_err(|e| format!("Watch error: {e}"))?;

        self.watched_paths.lock().unwrap().insert(path.to_string());
        Ok(())
    }

    /// Stop watching a directory
    pub fn unwatch(&self, path: &str) -> Result<(), String> {
        let mut watcher_guard = self._watcher.lock().unwrap();
        let watcher = watcher_guard.as_mut().ok_or("FsWatcher not started")?;

        let pb = PathBuf::from(path);
        let _ = watcher.watcher().unwatch(&pb);

        self.watched_paths.lock().unwrap().remove(path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_watcher_new_starts_with_empty_watched_paths() {
        let watcher = FsWatcher::new();
        assert_eq!(watcher.watched_paths.lock().unwrap().len(), 0);
    }

    #[test]
    fn fs_watcher_watch_fails_when_not_started() {
        let watcher = FsWatcher::new();
        let result = watcher.watch("/tmp");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not started"));
    }

    #[test]
    fn fs_watcher_unwatch_fails_when_not_started() {
        let watcher = FsWatcher::new();
        let result = watcher.unwatch("/tmp");
        assert!(result.is_err());
    }

    #[test]
    fn fs_change_event_serializes_and_deserializes() {
        let event = FsChangeEvent {
            path: "/tmp/test.txt".to_string(),
            kind: "any".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        let parsed: FsChangeEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.path, "/tmp/test.txt");
        assert_eq!(parsed.kind, "any");
    }

    #[test]
    fn is_excluded_path_filters_top_level_excludes() {
        assert!(is_excluded_path("C:\\repo\\node_modules\\foo.js"));
        assert!(is_excluded_path("C:\\repo\\.git\\HEAD"));
        assert!(is_excluded_path("C:\\repo\\target\\debug\\x.exe"));
        assert!(is_excluded_path("/home/u/proj/dist/index.js"));
        assert!(is_excluded_path("/home/u/proj/.next/cache/foo"));
    }

    #[test]
    fn is_excluded_path_filters_nested_excludes() {
        assert!(is_excluded_path(
            "C:\\repo\\packages\\a\\node_modules\\b.js"
        ));
        assert!(is_excluded_path("/repo/workspaces/x/target/y"));
    }

    #[test]
    fn is_excluded_path_does_not_filter_normal_source() {
        assert!(!is_excluded_path("C:\\repo\\src\\main.rs"));
        assert!(!is_excluded_path("C:\\repo\\README.md"));
        assert!(!is_excluded_path("/home/u/proj/lib/foo.ts"));
    }

    #[test]
    fn is_excluded_path_does_not_filter_lookalikes() {
        // Must match the FULL segment, not a substring
        assert!(!is_excluded_path("C:\\repo\\node_modules_backup\\foo"));
        assert!(!is_excluded_path("C:\\repo\\targeted\\thing"));
        assert!(!is_excluded_path("C:\\repo\\.github\\workflows\\ci.yml"));
    }
}
