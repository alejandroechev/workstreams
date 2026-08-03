//! Git diff helpers for the Code Review tile (ADR 014).
//!
//! Produces the diff for a review's chosen source. Vocabulary is the tile's
//! (`working_tree` | `last_commit` | `branch` + an arbitrary base ref) — kept
//! separate from the Repo Explorer diff commands so neither destabilises the
//! other. All git spawns suppress the console window on Windows.

use std::path::Path;
use std::process::Command;

/// Run `git` in `dir`, returning trimmed stdout. `allow_fail` tolerates a
/// non-zero exit (e.g. `git diff --no-index` returns 1 when files differ).
fn run_git(dir: &str, args: &[&str], allow_fail: bool) -> Result<String, String> {
    #[allow(unused_mut)]
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("git {args:?} failed to spawn: {e}"))?;
    if !out.status.success() && !allow_fail {
        return Err(format!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Like `run_git` but returns stdout **verbatim** (no trimming) and tolerates a
/// non-zero exit by yielding an empty string. Used for retrieving file content
/// (`git show <ref>:<file>`), where trailing newlines are significant and must
/// be preserved for the diff sides.
fn run_git_raw(dir: &str, args: &[&str]) -> String {
    #[allow(unused_mut)]
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    match cmd.output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    }
}

fn ref_exists(dir: &str, r: &str) -> bool {
    run_git(dir, &["rev-parse", "--verify", "--quiet", r], true)
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Resolve the base ref for a `branch` review: the caller's ref if it exists,
/// else `master`, else `main`. Returns None if none resolve.
pub fn resolve_base_ref(dir: &str, base_ref: Option<&str>) -> Option<String> {
    if let Some(r) = base_ref {
        let r = r.trim();
        if !r.is_empty() && ref_exists(dir, r) {
            return Some(r.to_string());
        }
    }
    for candidate in ["master", "main"] {
        if ref_exists(dir, candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Content of a file at a git ref, or empty string if absent at that ref.
/// Preserves the file's exact bytes (incl. trailing newline) so diff sides are
/// faithful.
fn show(dir: &str, git_ref: &str, file: &str) -> String {
    run_git_raw(dir, &["show", &format!("{git_ref}:{file}"), "--"])
}

fn read_working(dir: &str, file: &str) -> String {
    std::fs::read_to_string(Path::new(dir).join(file)).unwrap_or_default()
}

fn parse_name_status(out: &str) -> Vec<(String, String)> {
    let mut v = Vec::new();
    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let status = parts.next().unwrap_or("M");
        let status_char = status.chars().next().unwrap_or('M').to_string();
        // For renames (Rxxx) name-status has old\tnew; take the new path.
        let path = parts.next_back().unwrap_or("").to_string();
        if !path.is_empty() {
            v.push((path, status_char));
        }
    }
    v
}

/// Changed files (repo-relative) + status char for a review source.
/// `A` added, `M` modified, `D` deleted, `R` renamed.
pub fn diff_files_with_status(
    dir: &str,
    diff_source: &str,
    base_ref: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    match diff_source {
        "working_tree" => {
            let tracked = run_git(dir, &["diff", "--name-status", "HEAD"], false)?;
            let mut files = parse_name_status(&tracked);
            let untracked = run_git(dir, &["ls-files", "--others", "--exclude-standard"], false)?;
            for line in untracked.lines() {
                let p = line.trim();
                if !p.is_empty() && !files.iter().any(|(f, _)| f == p) {
                    files.push((p.to_string(), "A".to_string()));
                }
            }
            files.sort();
            Ok(files)
        }
        "last_commit" => {
            let out = run_git(dir, &["diff", "--name-status", "HEAD~1", "HEAD"], false)?;
            Ok(parse_name_status(&out))
        }
        "branch" => {
            let base = resolve_base_ref(dir, base_ref)
                .ok_or("no base ref (tried given ref, master, main)")?;
            let range = format!("{base}...HEAD");
            let out = run_git(dir, &["diff", "--name-status", &range], false)?;
            Ok(parse_name_status(&out))
        }
        other => Err(format!("unknown diff_source: {other}")),
    }
}

/// Both sides (before, after) of a file's diff as full contents, for the
/// Monaco DiffEditor. `after` is the on-disk working file for `working_tree`
/// (so in-place editing targets the real file), else the HEAD content.
pub fn diff_file_sides(
    dir: &str,
    file: &str,
    diff_source: &str,
    base_ref: Option<&str>,
) -> Result<(String, String), String> {
    match diff_source {
        "working_tree" => Ok((show(dir, "HEAD", file), read_working(dir, file))),
        "last_commit" => Ok((show(dir, "HEAD~1", file), show(dir, "HEAD", file))),
        "branch" => {
            let base = resolve_base_ref(dir, base_ref)
                .ok_or("no base ref (tried given ref, master, main)")?;
            Ok((show(dir, &base, file), show(dir, "HEAD", file)))
        }
        other => Err(format!("unknown diff_source: {other}")),
    }
}

/// True when a review source's modified side is the on-disk working file — the
/// only case in which in-place editing (ADR 014 §4) is valid.
pub fn modified_is_working_file(diff_source: &str) -> bool {
    diff_source == "working_tree"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn temp_repo() -> std::path::PathBuf {
        // A pid + timestamp name is not unique: `SystemTime::now()` only has
        // microsecond granularity on macOS, so two of these tests running
        // concurrently in the same process can land on the same nanos value,
        // share a directory, and race inside `git init` ("cannot copy
        // template hook: File exists"). A process-wide atomic counter makes
        // the name collision-proof regardless of clock resolution.
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cr-diff-{}-{}", std::process::id(), seq));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "master"]);
        git(&dir, &["config", "user.email", "t@t"]);
        git(&dir, &["config", "user.name", "t"]);
        dir
    }

    #[test]
    fn branch_source_diffs_against_resolved_base() {
        let dir = temp_repo();
        let ds = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(dir.join("b.txt"), "new file\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "feature work"]);

        // base_ref=None → resolves master.
        let files = diff_files_with_status(&ds, "branch", None).unwrap();
        assert!(files.iter().any(|(f, s)| f == "a.txt" && s == "M"));
        assert!(files.iter().any(|(f, s)| f == "b.txt" && s == "A"));

        let (before, after) = diff_file_sides(&ds, "a.txt", "branch", Some("master")).unwrap();
        assert_eq!(before, "one\ntwo\n");
        assert_eq!(after, "one\ntwo\nthree\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn working_tree_after_side_is_the_on_disk_file() {
        let dir = temp_repo();
        let ds = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "committed\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "c"]);
        // Uncommitted edit + a new untracked file.
        std::fs::write(dir.join("a.txt"), "committed\nedited\n").unwrap();
        std::fs::write(dir.join("u.txt"), "untracked\n").unwrap();

        let files = diff_files_with_status(&ds, "working_tree", None).unwrap();
        assert!(files.iter().any(|(f, s)| f == "a.txt" && s == "M"));
        assert!(files.iter().any(|(f, s)| f == "u.txt" && s == "A"));

        let (before, after) = diff_file_sides(&ds, "a.txt", "working_tree", None).unwrap();
        assert_eq!(before, "committed\n");
        assert_eq!(after, "committed\nedited\n"); // the on-disk working file
        assert!(modified_is_working_file("working_tree"));
        assert!(!modified_is_working_file("branch"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_base_ref_falls_back_master_then_main() {
        let dir = temp_repo();
        let ds = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("a.txt"), "x\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "c"]);
        // Bogus ref → falls back to master (the repo's default branch here).
        assert_eq!(
            resolve_base_ref(&ds, Some("nope/does-not-exist")).as_deref(),
            Some("master")
        );
        assert_eq!(
            resolve_base_ref(&ds, Some("master")).as_deref(),
            Some("master")
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
