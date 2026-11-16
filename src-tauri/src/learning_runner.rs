//! Compiles and tests a Rust Pocket answer (ADR 042).
//!
//! The phone sends the harness with each request, so this runs only fixed
//! commands: `rustc --test` for std-only cards and `cargo test --offline
//! --locked` with the pinned Serde manifest for Serde cards. Each job gets its
//! own directory, removed afterwards. These directories are not a sandbox: the
//! code runs with the user's permissions, as the learner chose.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// A named behavioral test; each becomes its own `#[test]`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TestCase {
    pub name: String,
    pub body: String,
}

/// A declared concept constraint, checked on the submitted source.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Constraint {
    pub id: String,
    pub label: String,
    /// A regular expression the answer must not match.
    pub forbid: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Harness {
    #[serde(default)]
    pub before: String,
    #[serde(default)]
    pub after: String,
    #[serde(default)]
    pub cases: Option<Vec<TestCase>>,
    #[serde(default)]
    pub tests: Option<String>,
    #[serde(default)]
    pub constraints: Option<Vec<Constraint>>,
    #[serde(default)]
    pub serde: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TestOutcome {
    pub name: String,
    pub passed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ConstraintOutcome {
    pub id: String,
    pub label: String,
    pub met: bool,
}

/// Mirrors the phone's `CheckResult` (`src/domain/types.ts` in rust-pocket).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CheckResult {
    /// passed | compile_error | tests_failed | constraint_failed | timeout | error
    pub status: String,
    pub output: String,
    pub toolchain: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tests: Option<Vec<TestOutcome>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub constraints: Option<Vec<ConstraintOutcome>>,
}

impl CheckResult {
    fn error(output: impl Into<String>, toolchain: impl Into<String>) -> Self {
        Self {
            status: "error".into(),
            output: output.into(),
            toolchain: toolchain.into(),
            tests: None,
            constraints: None,
        }
    }
}

pub const MAX_SOURCE: usize = 20_000;

#[derive(Clone, Debug)]
pub struct Limits {
    pub compile_std_ms: u64,
    pub compile_serde_ms: u64,
    pub run_ms: u64,
    pub output_chars: usize,
    /// e.g. "1.98.0"; `None` accepts any toolchain (tests).
    pub toolchain: Option<String>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            compile_std_ms: 30_000,
            compile_serde_ms: 120_000,
            run_ms: 10_000,
            output_chars: 16_000,
            toolchain: Some("1.98.0".into()),
        }
    }
}

/// The named tests of a harness; a single unnamed body is `expected_behavior`.
pub fn test_cases(harness: &Harness) -> Vec<TestCase> {
    match &harness.cases {
        Some(cases) if !cases.is_empty() => cases.clone(),
        _ => vec![TestCase {
            name: "expected_behavior".into(),
            body: harness.tests.clone().unwrap_or_default(),
        }],
    }
}

/// Each declared constraint, checked on the submitted source. An invalid
/// pattern counts as not met, so a broken card never passes silently.
pub fn check_constraints(harness: &Harness, source: &str) -> Vec<ConstraintOutcome> {
    harness
        .constraints
        .iter()
        .flatten()
        .map(|c| ConstraintOutcome {
            id: c.id.clone(),
            label: c.label.clone(),
            met: regex::Regex::new(&c.forbid).is_ok_and(|re| !re.is_match(source)),
        })
        .collect()
}

/// `test exercise_tests::<name> ... ok|FAILED` lines from libtest output.
pub fn parse_tests(output: &str, names: &[String]) -> Vec<TestOutcome> {
    names
        .iter()
        .filter_map(|name| {
            let prefix = format!("test exercise_tests::{name} ... ");
            output.lines().find_map(|line| {
                let rest = line.trim().strip_prefix(&prefix)?;
                Some(TestOutcome {
                    name: name.clone(),
                    passed: rest.starts_with("ok"),
                })
            })
        })
        .collect()
}

/// Cuts `text` to at most `limit` characters, marking the cut.
pub fn bounded(text: &str, limit: usize) -> String {
    const MARKER: &str = "\n[output truncated]";
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let keep = limit.saturating_sub(MARKER.chars().count());
    let mut out: String = text.chars().take(keep).collect();
    out.extend(MARKER.chars().take(limit - keep));
    out
}

/// The program `rustc`/`cargo` compiles.
pub fn program(harness: &Harness, source: &str) -> String {
    // Test names come from the request: only identifier characters survive.
    let tests: String = test_cases(harness)
        .iter()
        .map(|c| {
            let name: String = c
                .name
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .collect();
            format!("#[test] fn {name}() {{ {} }} ", c.body)
        })
        .collect();
    format!(
        "{}\n{}\n{}\n#[cfg(test)] mod exercise_tests {{ use super::*; {tests}}}\n",
        harness.before, source, harness.after
    )
}

/// Runs one check in a new directory under `root`, removed afterwards.
pub fn run_check(
    harness: &Harness,
    source: &str,
    root: &Path,
    limits: &Limits,
    path: Option<&str>,
) -> CheckResult {
    if source.chars().count() > MAX_SOURCE {
        return CheckResult::error("The answer is longer than 20,000 characters.", "");
    }
    if let Err(e) = std::fs::create_dir_all(root) {
        return CheckResult::error(format!("Could not create the job folder: {e}"), "");
    }
    let dir = root.join(format!("job-{}", uuid::Uuid::new_v4()));
    if let Err(e) = std::fs::create_dir(&dir) {
        return CheckResult::error(format!("Could not create the job folder: {e}"), "");
    }
    let result = check_in(harness, source, &dir, limits, path);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// The pinned manifest and lockfile Serde cards build against.
const SERDE_MANIFEST: &str = include_str!("../resources/learning/Cargo.toml");
const SERDE_LOCK: &str = include_str!("../resources/learning/Cargo.lock");

fn check_in(
    harness: &Harness,
    source: &str,
    dir: &Path,
    limits: &Limits,
    path: Option<&str>,
) -> CheckResult {
    let limit = limits.output_chars;
    let version = run(dir, "rustc", &["--version"], 10_000, 300, path);
    if version.spawn_error || version.code != Some(0) {
        return CheckResult::error(
            format!("Rust toolchain unavailable: {}", version.output),
            "",
        );
    }
    let toolchain = version.output.trim().to_string();
    if let Some(wanted) = &limits.toolchain {
        if !toolchain.starts_with(&format!("rustc {wanted}")) {
            return CheckResult::error(
                format!("This content version requires Rust {wanted}. Select that toolchain before running checks."),
                toolchain,
            );
        }
    }
    let cases = test_cases(harness);
    let constraints = check_constraints(harness, source);
    let serde = harness.serde.unwrap_or(false);
    let write = |name: &str, text: &str| std::fs::write(dir.join(name), text);
    let written = write("answer.rs", &program(harness, source)).and_then(|_| {
        if serde {
            write("Cargo.toml", SERDE_MANIFEST)?;
            write("Cargo.lock", SERDE_LOCK)
        } else {
            Ok(())
        }
    });
    if let Err(e) = written {
        return CheckResult::error(format!("Could not write the exercise: {e}"), toolchain);
    }
    let compile = if serde {
        run(
            dir,
            "cargo",
            &["test", "--offline", "--locked", "--no-run", "--quiet"],
            limits.compile_serde_ms,
            limit,
            path,
        )
    } else {
        run(
            dir,
            "rustc",
            &[
                "--edition=2021",
                "--test",
                "answer.rs",
                "-o",
                "answer-tests",
            ],
            limits.compile_std_ms,
            limit,
            path,
        )
    };
    let with = |status: &str, output: String, tests: Option<Vec<TestOutcome>>| CheckResult {
        status: status.into(),
        output,
        toolchain: toolchain.clone(),
        tests,
        constraints: Some(constraints.clone()),
    };
    if compile.timeout {
        return with(
            "timeout",
            bounded(
                &format!("Compilation timed out.\n{}", compile.output),
                limit,
            ),
            None,
        );
    }
    if compile.code != Some(0) {
        let infrastructure = compile.spawn_error
            || [
                "no matching package",
                "failed to download",
                "failed to get",
                "could not execute",
            ]
            .iter()
            .any(|s| compile.output.contains(s));
        return with(
            if infrastructure {
                "error"
            } else {
                "compile_error"
            },
            compile.output,
            None,
        );
    }
    let exe = dir.join("answer-tests");
    let exe = exe.to_string_lossy();
    let ran = if serde {
        run(
            dir,
            "cargo",
            &["test", "--offline", "--locked", "--", "--nocapture"],
            limits.run_ms,
            limit,
            path,
        )
    } else {
        run(dir, &exe, &["--nocapture"], limits.run_ms, limit, path)
    };
    let names: Vec<String> = cases.iter().map(|c| c.name.clone()).collect();
    let tests = parse_tests(&ran.output, &names);
    // Behavior first; only an advertised constraint can fail otherwise-passing code.
    let status = if ran.timeout {
        "timeout"
    } else if ran.spawn_error {
        "error"
    } else if ran.code != Some(0) {
        "tests_failed"
    } else if constraints.iter().all(|c| c.met) {
        "passed"
    } else {
        "constraint_failed"
    };
    let output = if ran.timeout {
        format!("Execution timed out.\n{}", ran.output)
    } else {
        ran.output
    };
    with(status, bounded(&output, limit), Some(tests))
}

pub(crate) struct Ran {
    pub(crate) code: Option<i32>,
    pub(crate) output: String,
    pub(crate) timeout: bool,
    pub(crate) spawn_error: bool,
}

/// Runs a command with a timeout and a character cap on its combined output.
/// On Unix it gets its own process group, so a timeout kills everything it
/// started (a test binary, rustc's linker, cargo's children).
pub(crate) fn run(
    dir: &Path,
    program: &str,
    args: &[&str],
    timeout_ms: u64,
    limit: usize,
    path: Option<&str>,
) -> Ran {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Ran {
                code: None,
                output: e.to_string(),
                timeout: false,
                spawn_error: true,
            };
        }
    };
    let collected = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    // Bytes, not chars: enough headroom for the char cap applied at the end.
    let byte_cap = limit.saturating_mul(4) + 64;
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|o| Box::new(o) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|e| Box::new(e) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|mut pipe| {
        let collected = collected.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut all = collected.lock().unwrap();
                let room = byte_cap.saturating_sub(all.len());
                all.extend_from_slice(&buf[..n.min(room)]);
                // Keep draining past the cap so the child never blocks on a full pipe.
            }
        })
    })
    .collect();
    let started = std::time::Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed().as_millis() as u64 >= timeout_ms => {
                timed_out = true;
                kill_group(&mut child);
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    // Whatever the command left behind in its group goes too: a descendant
    // holding the pipes open would otherwise keep the readers (and the only
    // worker) waiting past the timeout.
    if !timed_out {
        kill_group(&mut child);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    for reader in readers {
        while !reader.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let bytes = collected.lock().unwrap().clone();
    let truncated = bytes.len() >= byte_cap;
    let mut output = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        output.push_str("\n[output truncated]");
    }
    Ran {
        code: status.and_then(|s| s.code()),
        output: bounded(&output, limit),
        timeout: timed_out,
        spawn_error: false,
    }
}

fn kill_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        // The negative pid addresses the whole process group made at spawn.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn a_descendant_holding_the_output_cannot_outlive_the_job() {
        let dir = std::env::temp_dir();
        let started = std::time::Instant::now();
        // The shell exits at once; its background child keeps stdout open.
        let ran = run(
            &dir,
            "sh",
            &["-c", "echo done; sleep 8 &"],
            5_000,
            1_000,
            None,
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "waited {:?}",
            started.elapsed()
        );
        assert_eq!((ran.code, ran.timeout), (Some(0), false));
        assert!(ran.output.contains("done"));
    }

    use super::*;

    fn even() -> Harness {
        Harness {
            cases: Some(vec![
                TestCase {
                    name: "even_numbers".into(),
                    body: "for n in [-4, -2, 0, 2, 4] { assert!(is_even(n)); }".into(),
                },
                TestCase {
                    name: "odd_numbers".into(),
                    body: "for n in [-3, -1, 1, 3] { assert!(!is_even(n)); }".into(),
                },
            ]),
            ..Default::default()
        }
    }

    fn borrow() -> Harness {
        Harness {
            before: "pub fn borrowed_len() -> usize { fn len(s: &str) -> usize { s.len() } let name = String::from(\"Rust\"); let n = len(".into(),
            after: "); assert_eq!(name, \"Rust\"); n }".into(),
            tests: Some("assert_eq!(borrowed_len(), 4);".into()),
            constraints: Some(vec![Constraint {
                id: "borrow".into(),
                label: "Borrows name instead of copying it".into(),
                forbid: r"\.(clone|to_owned|to_string)\(|String::from".into(),
            }]),
            ..Default::default()
        }
    }

    fn any_toolchain() -> Limits {
        Limits {
            toolchain: None,
            ..Default::default()
        }
    }

    fn root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ws-learning-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rustc_available() -> bool {
        std::process::Command::new("rustc")
            .arg("--version")
            .output()
            .is_ok()
    }

    #[test]
    fn unnamed_tests_become_expected_behavior() {
        let cases = test_cases(&borrow());
        assert_eq!(cases.len(), 1);
        assert_eq!(cases[0].name, "expected_behavior");
        assert_eq!(test_cases(&even()).len(), 2);
    }

    #[test]
    fn constraints_are_checked_on_the_source_and_bad_patterns_fail_closed() {
        assert!(!check_constraints(&borrow(), "&name.clone()")[0].met);
        assert!(check_constraints(&borrow(), "& name")[0].met);
        let mut broken = borrow();
        broken.constraints.as_mut().unwrap()[0].forbid = "(".into();
        assert!(!check_constraints(&broken, "& name")[0].met);
    }

    #[test]
    fn parses_libtest_lines_per_test() {
        let out = "running 2 tests\ntest exercise_tests::even_numbers ... FAILED\ntest exercise_tests::odd_numbers ... ok\n";
        let names = vec![
            "even_numbers".to_string(),
            "odd_numbers".to_string(),
            "missing".to_string(),
        ];
        assert_eq!(
            parse_tests(out, &names),
            vec![
                TestOutcome {
                    name: "even_numbers".into(),
                    passed: false
                },
                TestOutcome {
                    name: "odd_numbers".into(),
                    passed: true
                },
            ]
        );
    }

    #[test]
    fn bounds_output_by_characters_with_a_marker() {
        assert_eq!(bounded("short", 100), "short");
        let cut = bounded(&"é".repeat(500), 100);
        assert!(cut.chars().count() <= 100);
        assert!(cut.ends_with("[output truncated]"));
    }

    #[test]
    fn the_program_wraps_answer_and_tests() {
        let program = program(&even(), "pub fn is_even(n: i32) -> bool { n % 2 == 0 }");
        assert!(program.contains("pub fn is_even"));
        assert!(program.contains("#[test] fn even_numbers()"));
        assert!(program.contains("#[test] fn odd_numbers()"));
    }

    #[test]
    fn real_checks_pass_fail_and_report_compile_errors() {
        if !rustc_available() {
            return;
        }
        let dir = root();
        let passed = run_check(
            &even(),
            "pub fn is_even(n: i32) -> bool { n % 2 == 0 }",
            &dir,
            &any_toolchain(),
            None,
        );
        assert_eq!(passed.status, "passed", "{}", passed.output);
        let failed = run_check(
            &even(),
            "pub fn is_even(n: i32) -> bool { n >= 0 && n % 2 == 0 }",
            &dir,
            &any_toolchain(),
            None,
        );
        assert_eq!(failed.status, "tests_failed");
        assert_eq!(
            failed.tests,
            Some(vec![
                TestOutcome {
                    name: "even_numbers".into(),
                    passed: false
                },
                TestOutcome {
                    name: "odd_numbers".into(),
                    passed: true
                },
            ])
        );
        let broken = run_check(
            &even(),
            "pub fn is_even(n: i32) -> bool { n }",
            &dir,
            &any_toolchain(),
            None,
        );
        assert_eq!(broken.status, "compile_error");
        assert!(
            broken.output.contains("mismatched types"),
            "{}",
            broken.output
        );
        let cloned = run_check(&borrow(), "&name.clone()", &dir, &any_toolchain(), None);
        assert_eq!(cloned.status, "constraint_failed");
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "job directories are removed"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_hanging_answer_times_out_and_noise_is_capped() {
        if !rustc_available() {
            return;
        }
        let dir = root();
        let limits = Limits {
            run_ms: 300,
            output_chars: 400,
            toolchain: None,
            ..Default::default()
        };
        let hung = run_check(
            &even(),
            "pub fn is_even(_: i32) -> bool { loop {} }",
            &dir,
            &limits,
            None,
        );
        assert_eq!(hung.status, "timeout");
        let noisy = run_check(&even(), &"not rust ".repeat(500), &dir, &limits, None);
        assert!(noisy.output.chars().count() <= 400);
        assert_ne!(noisy.status, "passed");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_wrong_toolchain_or_oversized_answer_is_an_error_not_a_result() {
        let dir = root();
        let wrong = Limits {
            toolchain: Some("0.0.1".into()),
            ..Default::default()
        };
        if rustc_available() {
            assert_eq!(run_check(&even(), "x", &dir, &wrong, None).status, "error");
        }
        let big = "x".repeat(MAX_SOURCE + 1);
        assert_eq!(
            run_check(&even(), &big, &dir, &any_toolchain(), None).status,
            "error"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// Needs the Serde crates in the local cargo cache (`cargo fetch` of the
    /// pinned manifest), so it is not run in CI.
    #[test]
    #[ignore]
    fn serde_cards_build_offline_against_the_pinned_manifest() {
        let dir = root();
        let harness = Harness {
            tests: Some("assert_eq!(points(\"{\\\"points\\\":7}\").unwrap(), 7);".into()),
            serde: Some(true),
            ..Default::default()
        };
        let result = run_check(
            &harness,
            "#[derive(serde::Deserialize)] struct S { points: u32 } pub fn points(t: &str) -> Result<u32, serde_json::Error> { Ok(serde_json::from_str::<S>(t)?.points) }",
            &dir,
            &any_toolchain(),
            None,
        );
        assert_eq!(result.status, "passed", "{}", result.output);
        std::fs::remove_dir_all(dir).ok();
    }
}
