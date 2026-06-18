//! End-to-end tests of the filter behavior by invoking the wrapper binary.
//!
//! These tests use `GIT_NOVERIFY_REAL_GIT` to point the wrapper at a
//! nonexistent path. When the filter passes through, the wrapper exits 127
//! (cannot find real git). When the filter blocks, it exits 1 before ever
//! trying to spawn git. Distinguishing these two exit codes lets us assert
//! block vs. pass-through without needing a real git on hand.

use std::process::Command;

fn wrapper_blocks(argv: &[&str], bypass: bool) -> bool {
    let bin = env!("CARGO_BIN_EXE_git-no-verify");
    let mut cmd = Command::new(bin);
    cmd.args(argv);
    cmd.env(
        "GIT_NOVERIFY_REAL_GIT",
        "C:\\nonexistent\\definitely-not-here.exe",
    );
    cmd.env_remove("GIT_NOVERIFY_SHIM_DEPTH");
    if bypass {
        cmd.env("GIT_NOVERIFY_BYPASS", "1");
    } else {
        cmd.env_remove("GIT_NOVERIFY_BYPASS");
    }
    let out = cmd.output().expect("spawn wrapper");
    let code = out.status.code().unwrap_or(-1);
    if code == 1 {
        let so = String::from_utf8_lossy(&out.stdout);
        let se = String::from_utf8_lossy(&out.stderr);
        assert!(so.contains("Hello AI Agent"), "stdout missing message: {so}");
        assert!(se.contains("Hello AI Agent"), "stderr missing message: {se}");
        true
    } else {
        assert_eq!(
            code,
            127,
            "unexpected exit code {code}; stderr={}",
            String::from_utf8_lossy(&out.stderr)
        );
        false
    }
}

#[test]
fn blocks_standalone_no_verify_commit() {
    assert!(wrapper_blocks(&["commit", "--no-verify", "-m", "x"], false));
}

#[test]
fn blocks_no_verify_on_push() {
    assert!(wrapper_blocks(&["push", "--no-verify"], false));
}

#[test]
fn does_not_block_no_verify_substring() {
    assert!(!wrapper_blocks(&["commit", "--no-verify-foo"], false));
}

#[test]
fn does_not_block_no_verify_inside_short_message() {
    assert!(!wrapper_blocks(
        &["commit", "-m", "fix --no-verify bug"],
        false
    ));
}

#[test]
fn does_not_block_no_verify_as_long_message_value() {
    assert!(!wrapper_blocks(&["commit", "--message", "--no-verify"], false));
}

#[test]
fn does_not_block_no_verify_in_fused_long_message() {
    assert!(!wrapper_blocks(&["commit", "--message=--no-verify"], false));
}

#[test]
fn does_not_block_no_verify_after_separator() {
    assert!(!wrapper_blocks(&["log", "--", "--no-verify"], false));
}

#[test]
fn bypass_env_disables_blocking() {
    assert!(!wrapper_blocks(&["commit", "--no-verify"], true));
}

#[test]
fn passes_through_empty_args() {
    assert!(!wrapper_blocks(&[], false));
}

#[test]
fn passes_through_normal_status() {
    assert!(!wrapper_blocks(&["status"], false));
}
