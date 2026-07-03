//! Git IO helpers for Local Agent Review (ADR 013).
//!
//! These shell out to `git` and are therefore impure — callers run them off the
//! UI/command thread (the re-anchor sweep in `submit_review_round` spawns a
//! background thread). Kept separate from the pure `anchor` engine so the
//! algorithm stays unit-testable without a repo.

use std::path::Path;
use std::process::Command;

/// Run `git` in `repo` and return trimmed stdout, or an error with stderr.
pub fn run_git(repo: &Path, args: &[&str]) -> Result<String, String> {
    #[allow(unused_mut)]
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(repo);
    // Don't flash a console window on Windows for each git invocation.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("git {args:?} failed to spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Absolute repo top-level for `dir` (works inside a linked worktree).
pub fn repo_root(dir: &Path) -> Result<String, String> {
    run_git(dir, &["rev-parse", "--show-toplevel"])
}

/// Current HEAD commit SHA.
pub fn head_sha(dir: &Path) -> Result<String, String> {
    run_git(dir, &["rev-parse", "HEAD"])
}

/// Merge-base of `a` and `b` (e.g. the fork point from `master`).
pub fn merge_base(dir: &Path, a: &str, b: &str) -> Result<String, String> {
    run_git(dir, &["merge-base", a, b])
}

/// Repo-relative, forward-slash path for an absolute file path. Falls back to
/// the input if it isn't under `root`.
pub fn rel_path(root: &str, absolute: &str) -> String {
    let root_n = root.replace('\\', "/");
    let abs_n = absolute.replace('\\', "/");
    let root_trim = root_n.trim_end_matches('/');
    if let Some(rest) = abs_n.strip_prefix(root_trim) {
        rest.trim_start_matches('/').to_string()
    } else {
        abs_n
    }
}

/// File content at a given ref (`git show <ref>:<relpath>`). Returns an empty
/// string when the file does not exist at that ref (e.g. it was deleted).
pub fn file_at_ref(dir: &Path, git_ref: &str, relpath: &str) -> Result<String, String> {
    match run_git(dir, &["show", &format!("{git_ref}:{relpath}")]) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

/// Unified diff for a single file between two refs (`from..to`).
pub fn diff_file(dir: &Path, from: &str, to: &str, relpath: &str) -> Result<String, String> {
    run_git(
        dir,
        &[
            "diff",
            "--unified=1",
            &format!("{from}..{to}"),
            "--",
            relpath,
        ],
    )
}

/// The most recent commit that touched `relpath` in `from..to`, as `"<short> <subject>"`,
/// or None. Uses `git log <from>..<to> -- <file>` (NOT `git log -L`, which the
/// spike proved aborts when the file shrinks).
pub fn fixing_commit(dir: &Path, from: &str, to: &str, relpath: &str) -> Option<String> {
    let range = format!("{from}..{to}");
    let out = run_git(dir, &["log", "--format=%h %s", &range, "--", relpath]).ok()?;
    out.lines()
        .map(|l| l.trim().to_string())
        .find(|l| !l.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_strips_root_and_normalizes_separators() {
        assert_eq!(
            rel_path("C:\\repo\\proj", "C:\\repo\\proj\\src\\a.rs"),
            "src/a.rs"
        );
        assert_eq!(rel_path("/home/x/repo", "/home/x/repo/a.js"), "a.js");
        // Not under root → returned as-is (normalized).
        assert_eq!(rel_path("/repo", "/other/a.js"), "/other/a.js");
    }
}
