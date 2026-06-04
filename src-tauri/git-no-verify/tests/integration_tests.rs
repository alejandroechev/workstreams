//! Broad functional integration tests.
//!
//! Each test runs git through the wrapper against a temp repo, with
//! `GIT_NOVERIFY_REAL_GIT` pointed at the system git. Asserts the wrapper
//! is transparent for all normal commands and only blocks `--no-verify`.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use tempfile::TempDir;

fn wrapper_bin() -> &'static str {
    env!("CARGO_BIN_EXE_git-no-verify")
}

/// Locate a real `git.exe` on the system. We intentionally search PATH and
/// skip any entry whose filename is our own wrapper, so these tests work
/// even after the user has installed the wrapper in `Program Files`.
fn real_git() -> PathBuf {
    if let Ok(p) = std::env::var("INTEGRATION_REAL_GIT") {
        return PathBuf::from(p);
    }
    let path = std::env::var_os("PATH").expect("PATH env");
    for dir in std::env::split_paths(&path) {
        for name in &["git.exe", "git-real.exe"] {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            // Avoid picking up our own wrapper.
            let out = Command::new(&candidate)
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env_remove("GIT_NOVERIFY_REAL_GIT")
                .env_remove("GIT_NOVERIFY_BYPASS")
                .output();
            if let Ok(o) = out {
                let s = String::from_utf8_lossy(&o.stdout);
                if s.starts_with("git version") {
                    return candidate;
                }
            }
        }
    }
    panic!("could not locate real git.exe on PATH");
}

fn cwd_run(cwd: &Path, args: &[&str]) -> Output {
    Command::new(wrapper_bin())
        .args(args)
        // Pass identity inline so we don't depend on user's global config.
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("GIT_NOVERIFY_REAL_GIT", real_git())
        .env_remove("GIT_NOVERIFY_BYPASS")
        .current_dir(cwd)
        .output()
        .expect("spawn wrapper")
}

fn cwd_run_bypass(cwd: &Path, args: &[&str]) -> Output {
    Command::new(wrapper_bin())
        .args(args)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("GIT_NOVERIFY_REAL_GIT", real_git())
        .env("GIT_NOVERIFY_BYPASS", "1")
        .current_dir(cwd)
        .output()
        .expect("spawn wrapper")
}

fn assert_ok(out: &Output, ctx: &str) {
    assert!(
        out.status.success(),
        "{ctx}: exit={:?} stdout={} stderr={}",
        out.status.code(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Create a fresh temp dir with an initialized git repo and one initial commit.
fn fresh_repo() -> (TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().to_path_buf();
    assert_ok(&cwd_run(&dir, &["init", "-q", "-b", "main"]), "init");
    std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "a.txt"]), "add");
    assert_ok(
        &cwd_run(&dir, &["commit", "-q", "-m", "initial"]),
        "initial commit",
    );
    (tmp, dir)
}

// ─── Pass-through correctness ──────────────────────────────────────────────

#[test]
fn version_passes_through() {
    let out = Command::new(wrapper_bin())
        .arg("--version")
        .env("GIT_NOVERIFY_REAL_GIT", real_git())
        .output()
        .expect("spawn");
    assert_ok(&out, "version");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.starts_with("git version"), "stdout={s}");
}

#[test]
fn init_creates_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let out = cwd_run(tmp.path(), &["init", "-q", "-b", "main"]);
    assert_ok(&out, "init");
    assert!(tmp.path().join(".git").is_dir());
}

#[test]
fn status_on_empty_repo() {
    let (_g, dir) = fresh_repo();
    let out = cwd_run(&dir, &["status", "--porcelain"]);
    assert_ok(&out, "status");
    assert!(out.stdout.is_empty(), "porcelain status should be empty");
}

#[test]
fn add_and_status_shows_change() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("b.txt"), "x\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "b.txt"]), "add");
    let out = cwd_run(&dir, &["status", "--porcelain"]);
    assert_ok(&out, "status");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("b.txt"), "stdout={s}");
}

#[test]
fn commit_succeeds() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("c.txt"), "x\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "c.txt"]), "add");
    assert_ok(
        &cwd_run(&dir, &["commit", "-q", "-m", "add c"]),
        "second commit",
    );
}

#[test]
fn log_shows_commits() {
    let (_g, dir) = fresh_repo();
    let out = cwd_run(&dir, &["log", "--oneline"]);
    assert_ok(&out, "log");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("initial"), "stdout={s}");
}

#[test]
fn diff_shows_unstaged_change() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("a.txt"), "hello\nworld\n").unwrap();
    let out = cwd_run(&dir, &["diff"]);
    assert_ok(&out, "diff");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("+world"), "stdout={s}");
}

#[test]
fn branch_list_and_create() {
    let (_g, dir) = fresh_repo();
    assert_ok(&cwd_run(&dir, &["branch", "feature"]), "branch create");
    let out = cwd_run(&dir, &["branch", "--list"]);
    assert_ok(&out, "branch list");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("feature"), "stdout={s}");
}

#[test]
fn checkout_branch() {
    let (_g, dir) = fresh_repo();
    assert_ok(&cwd_run(&dir, &["branch", "feature"]), "branch");
    assert_ok(&cwd_run(&dir, &["checkout", "feature"]), "checkout");
}

#[test]
fn switch_create_branch() {
    let (_g, dir) = fresh_repo();
    assert_ok(&cwd_run(&dir, &["switch", "-c", "topic"]), "switch -c");
}

#[test]
fn tag_create_and_list() {
    let (_g, dir) = fresh_repo();
    assert_ok(&cwd_run(&dir, &["tag", "v1"]), "tag create");
    let out = cwd_run(&dir, &["tag", "--list"]);
    assert_ok(&out, "tag list");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("v1"), "stdout={s}");
}

#[test]
fn show_head() {
    let (_g, dir) = fresh_repo();
    let out = cwd_run(&dir, &["show", "HEAD"]);
    assert_ok(&out, "show");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("initial"), "stdout={s}");
}

#[test]
fn rev_parse_head() {
    let (_g, dir) = fresh_repo();
    let out = cwd_run(&dir, &["rev-parse", "HEAD"]);
    assert_ok(&out, "rev-parse");
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(s.len(), 40, "expected 40-char sha, got {s:?}");
}

#[test]
fn ls_files_lists_tracked() {
    let (_g, dir) = fresh_repo();
    let out = cwd_run(&dir, &["ls-files"]);
    assert_ok(&out, "ls-files");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("a.txt"), "stdout={s}");
}

#[test]
fn blame_shows_author() {
    let (_g, dir) = fresh_repo();
    let out = cwd_run(&dir, &["blame", "a.txt"]);
    assert_ok(&out, "blame");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("hello"), "stdout={s}");
}

#[test]
fn config_local_set_and_get() {
    let (_g, dir) = fresh_repo();
    assert_ok(
        &cwd_run(&dir, &["config", "--local", "myapp.key", "value42"]),
        "config set",
    );
    let out = cwd_run(&dir, &["config", "--local", "myapp.key"]);
    assert_ok(&out, "config get");
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(s, "value42");
}

#[test]
fn reset_soft_undoes_commit() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("d.txt"), "x\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "d.txt"]), "add");
    assert_ok(&cwd_run(&dir, &["commit", "-q", "-m", "add d"]), "commit");
    assert_ok(&cwd_run(&dir, &["reset", "--soft", "HEAD~1"]), "reset");
    let out = cwd_run(&dir, &["status", "--porcelain"]);
    assert_ok(&out, "status after reset");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("d.txt"), "expected d.txt staged; stdout={s}");
}

#[test]
fn revert_creates_inverse_commit() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("e.txt"), "x\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "e.txt"]), "add");
    assert_ok(&cwd_run(&dir, &["commit", "-q", "-m", "add e"]), "commit");
    assert_ok(
        &cwd_run(&dir, &["revert", "--no-edit", "HEAD"]),
        "revert",
    );
    assert!(!dir.join("e.txt").exists(), "revert should remove e.txt");
}

#[test]
fn cherry_pick_applies_commit() {
    let (_g, dir) = fresh_repo();
    assert_ok(&cwd_run(&dir, &["branch", "feature"]), "branch");
    assert_ok(&cwd_run(&dir, &["checkout", "feature"]), "checkout feature");
    std::fs::write(dir.join("f.txt"), "x\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "f.txt"]), "add");
    assert_ok(&cwd_run(&dir, &["commit", "-q", "-m", "add f"]), "commit f");
    let sha_out = cwd_run(&dir, &["rev-parse", "HEAD"]);
    let sha = String::from_utf8_lossy(&sha_out.stdout).trim().to_string();
    assert_ok(&cwd_run(&dir, &["checkout", "main"]), "checkout main");
    assert_ok(&cwd_run(&dir, &["cherry-pick", &sha]), "cherry-pick");
    assert!(dir.join("f.txt").exists());
}

#[test]
fn stash_push_list_pop() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("a.txt"), "hello\nchange\n").unwrap();
    assert_ok(&cwd_run(&dir, &["stash", "push", "-m", "wip"]), "stash push");
    let out = cwd_run(&dir, &["stash", "list"]);
    assert_ok(&out, "stash list");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("wip"), "stdout={s}");
    assert_ok(&cwd_run(&dir, &["stash", "pop"]), "stash pop");
}

#[test]
fn remote_add_list_remove() {
    let (_g, dir) = fresh_repo();
    assert_ok(
        &cwd_run(&dir, &["remote", "add", "origin", "https://example.com/x.git"]),
        "remote add",
    );
    let out = cwd_run(&dir, &["remote", "-v"]);
    assert_ok(&out, "remote -v");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("origin"), "stdout={s}");
    assert_ok(&cwd_run(&dir, &["remote", "remove", "origin"]), "remote remove");
}

#[test]
fn merge_fast_forward() {
    let (_g, dir) = fresh_repo();
    assert_ok(&cwd_run(&dir, &["switch", "-c", "feature"]), "switch");
    std::fs::write(dir.join("m.txt"), "x\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "m.txt"]), "add");
    assert_ok(&cwd_run(&dir, &["commit", "-q", "-m", "add m"]), "commit");
    assert_ok(&cwd_run(&dir, &["checkout", "main"]), "checkout main");
    assert_ok(&cwd_run(&dir, &["merge", "--ff-only", "feature"]), "merge ff");
    assert!(dir.join("m.txt").exists());
}

#[test]
fn rebase_onto_main() {
    let (_g, dir) = fresh_repo();
    assert_ok(&cwd_run(&dir, &["switch", "-c", "feature"]), "switch");
    std::fs::write(dir.join("r.txt"), "x\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "r.txt"]), "add");
    assert_ok(&cwd_run(&dir, &["commit", "-q", "-m", "add r"]), "commit");
    assert_ok(&cwd_run(&dir, &["rebase", "main"]), "rebase");
}

#[test]
fn clone_local_repo() {
    let (_g, src) = fresh_repo();
    let dst_parent = tempfile::tempdir().unwrap();
    let dst = dst_parent.path().join("cloned");
    let src_url = src.to_string_lossy().replace('\\', "/");
    let out = cwd_run(
        dst_parent.path(),
        &["clone", "-q", &src_url, &dst.to_string_lossy()],
    );
    assert_ok(&out, "clone");
    assert!(dst.join(".git").is_dir());
}

#[test]
fn fetch_from_local_remote() {
    let (_g, src) = fresh_repo();
    let (_g2, dst) = fresh_repo();
    let src_url = src.to_string_lossy().replace('\\', "/");
    assert_ok(
        &cwd_run(&dst, &["remote", "add", "src", &src_url]),
        "remote add",
    );
    assert_ok(&cwd_run(&dst, &["fetch", "-q", "src"]), "fetch");
}

#[test]
fn apply_patch_from_stdin() {
    let (_g, dir) = fresh_repo();
    // Create a patch by diffing a modification then resetting.
    std::fs::write(dir.join("a.txt"), "hello\nworld\n").unwrap();
    let diff = cwd_run(&dir, &["diff"]);
    assert_ok(&diff, "diff");
    let patch = diff.stdout.clone();
    std::fs::write(dir.join("a.txt"), "hello\n").unwrap(); // reset working tree

    let mut child = Command::new(wrapper_bin())
        .args(["apply"])
        .current_dir(&dir)
        .env("GIT_NOVERIFY_REAL_GIT", real_git())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn apply");
    use std::io::Write;
    child.stdin.as_mut().unwrap().write_all(&patch).unwrap();
    let out = child.wait_with_output().unwrap();
    assert_ok(&out, "apply");
    let s = std::fs::read_to_string(dir.join("a.txt")).unwrap();
    assert!(s.contains("world"), "patch should have added world: {s:?}");
}

#[test]
fn worktree_add_and_remove() {
    let (_g, dir) = fresh_repo();
    let wt_parent = tempfile::tempdir().unwrap();
    let wt = wt_parent.path().join("wt");
    assert_ok(
        &cwd_run(&dir, &["worktree", "add", &wt.to_string_lossy(), "-b", "wtbranch"]),
        "worktree add",
    );
    assert!(wt.join(".git").exists());
    assert_ok(
        &cwd_run(&dir, &["worktree", "remove", "--force", &wt.to_string_lossy()]),
        "worktree remove",
    );
}

// ─── Exit-code & stdio behavior ────────────────────────────────────────────

#[test]
fn nonzero_exit_propagates() {
    let tmp = tempfile::tempdir().unwrap();
    // `git status` outside a repo exits non-zero (128).
    let out = cwd_run(tmp.path(), &["status"]);
    assert!(!out.status.success(), "expected failure");
    assert_eq!(out.status.code(), Some(128));
}

#[test]
fn unknown_subcommand_propagates() {
    let (_g, dir) = fresh_repo();
    let out = cwd_run(&dir, &["this-is-not-a-real-subcommand-xyz"]);
    assert!(!out.status.success(), "expected failure");
}

#[test]
fn stdout_and_stderr_are_separate() {
    let (_g, dir) = fresh_repo();
    // `git status` writes to stdout, not stderr.
    let out = cwd_run(&dir, &["status"]);
    assert_ok(&out, "status");
    assert!(!out.stdout.is_empty(), "expected stdout");
    // stderr should be empty for a clean status.
    assert!(
        out.stderr.is_empty(),
        "expected empty stderr, got {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

// ─── --no-verify enforcement end-to-end ───────────────────────────────────

#[test]
fn end_to_end_blocks_commit_no_verify() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("x.txt"), "x\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "x.txt"]), "add");
    let out = cwd_run(&dir, &["commit", "--no-verify", "-m", "x"]);
    assert!(!out.status.success());
    assert_eq!(out.status.code(), Some(1));
    let so = String::from_utf8_lossy(&out.stdout);
    let se = String::from_utf8_lossy(&out.stderr);
    assert!(so.contains("Hello AI Agent"), "stdout={so}");
    assert!(se.contains("Hello AI Agent"), "stderr={se}");
}

#[test]
fn end_to_end_bypass_allows_commit_no_verify() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("y.txt"), "y\n").unwrap();
    assert_ok(&cwd_run_bypass(&dir, &["add", "y.txt"]), "add");
    let out = cwd_run_bypass(&dir, &["commit", "--no-verify", "-q", "-m", "y"]);
    assert_ok(&out, "commit with bypass");
}

#[test]
fn end_to_end_message_with_no_verify_literal_is_allowed() {
    let (_g, dir) = fresh_repo();
    std::fs::write(dir.join("z.txt"), "z\n").unwrap();
    assert_ok(&cwd_run(&dir, &["add", "z.txt"]), "add");
    let out = cwd_run(&dir, &["commit", "-q", "-m", "doc: discuss --no-verify"]);
    assert_ok(&out, "commit with --no-verify in message");
}

#[test]
fn end_to_end_after_double_dash_is_allowed() {
    let (_g, dir) = fresh_repo();
    // `git log -- <pathspec>` with a non-existent path succeeds with empty output.
    let out = cwd_run(&dir, &["log", "--oneline", "--", "--no-verify"]);
    assert_ok(&out, "log -- --no-verify");
}
