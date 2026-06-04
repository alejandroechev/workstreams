//! Tests for the new PATH-scrubbing + recursion-guard behavior introduced
//! when the wrapper moved from "replace system git.exe" to "PATH-shim
//! scoped to workstreams sessions".
//!
//! We build a fake `git.exe` that does nothing (just exits 0) and put it
//! in a sibling dir, then construct PATH such that:
//!   - the wrapper's own dir is on PATH (simulating the shim install)
//!   - the fake git dir is on PATH *after* the wrapper dir
//! The wrapper should scrub its own dir, find the fake git, and spawn it
//! exactly once with `GIT_NOVERIFY_SHIM_DEPTH=1` set.

use std::path::PathBuf;
use std::process::Command;

fn wrapper_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_git-no-verify"))
}

/// Returns the directory containing the wrapper binary.
fn wrapper_dir() -> PathBuf {
    wrapper_bin().parent().unwrap().to_path_buf()
}

/// Build a tiny "fake git" Rust source that records its argv and env into
/// a file given by `FAKE_GIT_OUT`, then exits 0. We compile it once per
/// test process via a `OnceLock` and cache the resulting exe path.
fn fake_git_exe() -> PathBuf {
    use std::sync::OnceLock;
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let tmp = std::env::temp_dir().join("gnv-fake-git-build");
            std::fs::create_dir_all(&tmp).unwrap();
            let src = tmp.join("fake_git.rs");
            std::fs::write(
                &src,
                r#"
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
fn main() {
    if let Ok(path) = env::var("FAKE_GIT_OUT") {
        let mut f = OpenOptions::new().create(true).append(true).open(&path).unwrap();
        let args: Vec<String> = env::args().skip(1).collect();
        writeln!(f, "ARGS:{}", args.join("|")).unwrap();
        writeln!(f, "DEPTH:{}", env::var("GIT_NOVERIFY_SHIM_DEPTH").unwrap_or_default()).unwrap();
        writeln!(f, "PATH:{}", env::var("PATH").unwrap_or_default()).unwrap();
    }
    println!("git version 0.0.0-fake");
}
"#,
            )
            .unwrap();
            let exe_dir = tmp.join("bin");
            std::fs::create_dir_all(&exe_dir).unwrap();
            let exe = exe_dir.join(if cfg!(windows) { "git.exe" } else { "git" });
            let status = Command::new("rustc")
                .arg(&src)
                .arg("-O")
                .arg("-o")
                .arg(&exe)
                .status()
                .expect("rustc");
            assert!(status.success(), "rustc failed");
            exe
        })
        .clone()
}

fn fake_git_dir() -> PathBuf {
    fake_git_exe().parent().unwrap().to_path_buf()
}

/// Build a PATH that puts the wrapper dir FIRST (simulating shim install)
/// and the fake-git dir second. The wrapper should scrub itself out.
fn shim_first_path() -> std::ffi::OsString {
    let parts: Vec<PathBuf> = vec![wrapper_dir(), fake_git_dir()];
    std::env::join_paths(parts).unwrap()
}

// ─── Recursion guard ───────────────────────────────────────────────────────

#[test]
fn recursion_guard_refuses_when_depth_set() {
    let out = Command::new(wrapper_bin())
        .arg("--version")
        .env("GIT_NOVERIFY_SHIM_DEPTH", "1")
        .env_remove("GIT_NOVERIFY_REAL_GIT")
        .output()
        .expect("spawn");
    let code = out.status.code().unwrap_or(-1);
    assert_eq!(code, 2, "expected recursion-guard exit 2, got {code}");
    let se = String::from_utf8_lossy(&out.stderr);
    assert!(
        se.contains("refusing to recurse"),
        "expected recursion message; stderr={se}"
    );
}

// ─── PATH scrubbing ────────────────────────────────────────────────────────

#[test]
fn scrubs_own_dir_and_finds_fake_git() {
    let out_log = std::env::temp_dir().join(format!(
        "gnv-fake-git-out-{}.log",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&out_log);

    let status = Command::new(wrapper_bin())
        .args(["status", "--porcelain"])
        .env("PATH", shim_first_path())
        .env("FAKE_GIT_OUT", &out_log)
        .env_remove("GIT_NOVERIFY_REAL_GIT") // force real PATH-scrub path
        .env_remove("GIT_NOVERIFY_SHIM_DEPTH")
        .env_remove("GIT_NOVERIFY_BYPASS")
        .status()
        .expect("spawn");
    assert!(status.success(), "wrapper exit was {:?}", status.code());

    let recorded = std::fs::read_to_string(&out_log).expect("fake-git log");
    assert!(
        recorded.contains("ARGS:status|--porcelain"),
        "fake git was not invoked correctly; log:\n{recorded}"
    );
    assert!(
        recorded.contains("DEPTH:1"),
        "child should have GIT_NOVERIFY_SHIM_DEPTH=1 set; log:\n{recorded}"
    );
    let path_line = recorded
        .lines()
        .find(|l| l.starts_with("PATH:"))
        .expect("PATH line");
    let wrapper_dir_str = wrapper_dir().to_string_lossy().to_string();
    assert!(
        !path_line.to_ascii_lowercase().contains(&wrapper_dir_str.to_ascii_lowercase()),
        "child PATH still contains wrapper dir!\n  wrapper_dir={wrapper_dir_str}\n  path_line={path_line}"
    );

    // Exactly one invocation — recursion would write multiple ARGS lines.
    let arg_lines = recorded.lines().filter(|l| l.starts_with("ARGS:")).count();
    assert_eq!(
        arg_lines, 1,
        "expected exactly 1 fake-git invocation, got {arg_lines}; log:\n{recorded}"
    );
}

#[test]
fn fails_with_127_when_no_real_git_on_scrubbed_path() {
    // PATH contains ONLY the wrapper dir → after scrub, nothing.
    let only_wrapper = std::env::join_paths(vec![wrapper_dir()]).unwrap();
    let out = Command::new(wrapper_bin())
        .arg("status")
        .env("PATH", only_wrapper)
        .env_remove("GIT_NOVERIFY_REAL_GIT")
        .env_remove("GIT_NOVERIFY_SHIM_DEPTH")
        .env_remove("GIT_NOVERIFY_BYPASS")
        .output()
        .expect("spawn");
    let code = out.status.code().unwrap_or(-1);
    assert_eq!(code, 127, "expected 127, got {code}");
    let se = String::from_utf8_lossy(&out.stderr);
    assert!(
        se.contains("cannot locate real git"),
        "expected helpful error; stderr={se}"
    );
}

#[test]
fn block_path_still_works_with_path_scrub_setup() {
    // The block decision happens BEFORE we attempt to resolve real git, so
    // even with no real git available, --no-verify should be blocked cleanly.
    let only_wrapper = std::env::join_paths(vec![wrapper_dir()]).unwrap();
    let out = Command::new(wrapper_bin())
        .args(["commit", "--no-verify", "-m", "x"])
        .env("PATH", only_wrapper)
        .env_remove("GIT_NOVERIFY_REAL_GIT")
        .env_remove("GIT_NOVERIFY_SHIM_DEPTH")
        .env_remove("GIT_NOVERIFY_BYPASS")
        .output()
        .expect("spawn");
    let code = out.status.code().unwrap_or(-1);
    assert_eq!(code, 1, "expected block exit 1, got {code}");
    let se = String::from_utf8_lossy(&out.stderr);
    assert!(se.contains("Hello AI Agent"));
}
