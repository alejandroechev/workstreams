//! Performance tests. Run with:
//!   cargo test --release --test perf_tests -- --ignored --nocapture
//!
//! Marked `#[ignore]` so they don't run on the default `cargo test` (which
//! uses debug builds and would produce meaningless overhead numbers).

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

fn wrapper_bin() -> &'static str {
    env!("CARGO_BIN_EXE_git-no-verify")
}

fn real_git() -> PathBuf {
    if let Ok(p) = std::env::var("INTEGRATION_REAL_GIT") {
        return PathBuf::from(p);
    }
    let path = std::env::var_os("PATH").expect("PATH");
    for dir in std::env::split_paths(&path) {
        for name in &["git.exe", "git-real.exe"] {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            let out = Command::new(&candidate)
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();
            if let Ok(o) = out {
                if String::from_utf8_lossy(&o.stdout).starts_with("git version") {
                    return candidate;
                }
            }
        }
    }
    panic!("could not locate real git.exe");
}

fn time_n<F: FnMut()>(n: usize, mut f: F) -> std::time::Duration {
    let start = Instant::now();
    for _ in 0..n {
        f();
    }
    start.elapsed()
}

const ITER: usize = 100;
const OVERHEAD_BUDGET_MS: f64 = 10.0;
const WALLCLOCK_MULTIPLIER: f64 = 2.0;

#[test]
#[ignore]
fn overhead_per_invocation_under_10ms() {
    let rg = real_git();

    // Warmup
    for _ in 0..10 {
        let _ = Command::new(&rg).arg("--version").output();
        let _ = Command::new(wrapper_bin())
            .arg("--version")
            .env("GIT_NOVERIFY_REAL_GIT", &rg)
            .output();
    }

    let direct = time_n(ITER, || {
        let _ = Command::new(&rg)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .expect("direct");
    });

    let via_wrapper = time_n(ITER, || {
        let _ = Command::new(wrapper_bin())
            .arg("--version")
            .env("GIT_NOVERIFY_REAL_GIT", &rg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .expect("wrapper");
    });

    let direct_ms = direct.as_secs_f64() * 1000.0 / ITER as f64;
    let wrapped_ms = via_wrapper.as_secs_f64() * 1000.0 / ITER as f64;
    let overhead_ms = wrapped_ms - direct_ms;

    println!(
        "direct={direct_ms:.2}ms wrapper={wrapped_ms:.2}ms overhead={overhead_ms:.2}ms (n={ITER})"
    );

    assert!(
        overhead_ms < OVERHEAD_BUDGET_MS,
        "wrapper overhead {overhead_ms:.2}ms exceeds budget {OVERHEAD_BUDGET_MS}ms"
    );
}

#[test]
#[ignore]
fn sequential_rev_parse_under_2x_baseline() {
    let rg = real_git();

    // Set up a temp repo with one commit so rev-parse HEAD succeeds.
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let setup = |args: &[&str]| {
        let out = Command::new(&rg)
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@e.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@e.com")
            .output()
            .expect("setup");
        assert!(out.status.success(), "{args:?}");
    };
    setup(&["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a"), "x").unwrap();
    setup(&["add", "a"]);
    setup(&["commit", "-q", "-m", "x"]);

    // Warmup
    for _ in 0..5 {
        let _ = Command::new(&rg)
            .args(["rev-parse", "HEAD"])
            .current_dir(dir)
            .output();
    }

    let direct = time_n(ITER, || {
        let _ = Command::new(&rg)
            .args(["rev-parse", "HEAD"])
            .current_dir(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .expect("direct");
    });

    let via_wrapper = time_n(ITER, || {
        let _ = Command::new(wrapper_bin())
            .args(["rev-parse", "HEAD"])
            .current_dir(dir)
            .env("GIT_NOVERIFY_REAL_GIT", &rg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .expect("wrapper");
    });

    let direct_ms = direct.as_secs_f64() * 1000.0;
    let wrapped_ms = via_wrapper.as_secs_f64() * 1000.0;
    let ratio = wrapped_ms / direct_ms;

    println!(
        "n={ITER} direct={direct_ms:.0}ms wrapper={wrapped_ms:.0}ms ratio={ratio:.2}x"
    );

    assert!(
        ratio < WALLCLOCK_MULTIPLIER,
        "wrapper wall-clock {wrapped_ms:.0}ms is {ratio:.2}x baseline {direct_ms:.0}ms (budget {WALLCLOCK_MULTIPLIER}x)"
    );
}
