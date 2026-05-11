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
                        // Deduplicate paths
                        let mut seen = HashSet::new();
                        for event in events {
                            if event.kind == DebouncedEventKind::Any {
                                let path_str = event.path.to_string_lossy().to_string();
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
