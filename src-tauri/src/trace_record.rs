//! Records a Rust test's execution as an ordered list of source locations, by
//! driving `lldb-dap` over the Debug Adapter Protocol.
//!
//! This is a port of `scripts/trace-record.mjs` into the app. The CLI remains
//! the reference implementation and the scriptable entry point; this exists so
//! the **bundled** app can record without depending on Node or on the repo's
//! `scripts/` folder being present — neither ships in a `.app`, so shelling out
//! would only have worked when the open workstream happened to be this repo.
//!
//! See ADR 018 for why record and replay are separate halves at all.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::{Path, MAIN_SEPARATOR};
use std::process::{Child, Command, Stdio};

use serde::{Deserialize, Serialize};

/// Schema version written by this recorder. Must match `domain/trace-format.ts`.
pub const TRACE_FORMAT_VERSION: u32 = 1;

/// A single recorded location.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TraceStep {
    /// Repo-relative, so a trace survives being moved between machines.
    pub file: String,
    /// 1-based, matching DAP's `linesStartAt1`.
    pub line: u32,
    pub function: String,
    /// Present only when consecutive identical locations were collapsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hits: Option<u32>,
    /// Call-stack depth as reported by the debugger. Absolute, not relative:
    /// a Rust test sits ~22 frames inside the libtest harness, so these start
    /// in the twenties and only comparisons between steps are meaningful.
    /// Drives an exact "step out" — including under recursion, where the
    /// caller shares the callee's name and a name-based rule picks the wrong
    /// frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceFile {
    pub version: u32,
    pub test: String,
    #[serde(rename = "repoRoot")]
    pub repo_root: String,
    #[serde(rename = "commitSha")]
    pub commit_sha: String,
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    pub truncated: bool,
    pub steps: Vec<TraceStep>,
}

/// Pick the test executable out of `cargo test --no-run --message-format=json`.
///
/// Cargo reports the built path directly, which avoids guessing the hash suffix
/// it appends. Unit tests live in the lib target, so that one wins when several
/// test binaries were built.
pub fn select_test_executable(stdout: &str) -> Result<String, String> {
    let mut candidates: Vec<(String, String)> = Vec::new();
    for line in stdout.lines() {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // cargo interleaves human-readable progress lines
        };
        let is_test = msg
            .get("profile")
            .and_then(|p| p.get("test"))
            .and_then(|t| t.as_bool())
            == Some(true);
        let exe = msg.get("executable").and_then(|e| e.as_str());
        if let (true, Some(exe)) = (is_test, exe) {
            let name = msg
                .get("target")
                .and_then(|t| t.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            candidates.push((name, exe.to_string()));
        }
    }
    if candidates.is_empty() {
        return Err(
            "no test executable found — `cargo test --no-run` produced no test binary. \
             Check that the crate compiles."
                .to_string(),
        );
    }
    let chosen = candidates
        .iter()
        .find(|(name, _)| name.ends_with("_lib"))
        .unwrap_or(&candidates[0]);
    Ok(chosen.1.clone())
}

/// Whether a stack frame belongs to the code under study.
///
/// This is the step-out trigger. Without it a single `assert_eq!` descends into
/// thousands of frames of `core`/`alloc` machinery the reader never asked for
/// and often has no source for. Generated code under `target/` is excluded for
/// the same reason.
pub fn is_our_code(file: Option<&str>, repo_root: &str) -> bool {
    let Some(file) = file.filter(|f| !f.is_empty()) else {
        return false;
    };
    let root = repo_root.trim_end_matches(['/', '\\']);
    // The separator guard stops `/repo-other` from matching root `/repo`.
    if file != root && !file.starts_with(&format!("{root}{MAIN_SEPARATOR}")) {
        return false;
    }
    !file.contains(&format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}"))
}

/// Strip rustc's `::h<hash>` suffix from a symbol name.
pub fn demangle(name: Option<&str>) -> String {
    match name {
        Some(n) => n.split("::h").next().unwrap_or(n).to_string(),
        None => String::new(),
    }
}

/// Append a location, collapsing it into the previous entry when identical.
///
/// A line such as `Some(s) if s.trim().starts_with('/')` makes several std
/// calls; the recorder steps into each and immediately back out, landing on
/// that same line every time. Recorded raw, the reader sees one line repeated
/// eight times — debugger mechanics presented as execution history.
///
/// Only *consecutive* duplicates collapse, so loop revisits (52 → 53 → 52)
/// survive intact: control returns via a different line first.
pub fn append_step(steps: &mut Vec<TraceStep>, step: TraceStep) {
    if let Some(prev) = steps.last_mut() {
        if prev.file == step.file && prev.line == step.line && prev.function == step.function {
            prev.hits = Some(prev.hits.unwrap_or(1) + 1);
            return;
        }
    }
    steps.push(step);
}

/// Encode a DAP message. Length is in *bytes* — a non-ASCII path would
/// otherwise desync the stream.
pub fn encode_dap_message(payload: &serde_json::Value) -> Vec<u8> {
    let body = payload.to_string();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// Split a buffer into complete DAP messages, returning them plus the
/// unconsumed remainder. Frames split across reads are left in the remainder;
/// a frame whose body is not JSON is dropped rather than stalling the stream
/// behind it.
pub fn read_dap_messages(buffer: &[u8]) -> (Vec<serde_json::Value>, Vec<u8>) {
    let mut messages = Vec::new();
    let mut rest = buffer;
    while let Some(header_end) = find_subsequence(rest, b"\r\n\r\n") {
        let header = String::from_utf8_lossy(&rest[..header_end]);
        let length = header.lines().find_map(|l| {
            let lower = l.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        });
        let Some(length) = length else {
            rest = &rest[header_end + 4..];
            continue;
        };
        let start = header_end + 4;
        if rest.len() < start + length {
            break; // wait for more bytes
        }
        let body = &rest[start..start + length];
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) {
            messages.push(value);
        }
        rest = &rest[start + length..];
    }
    (messages, rest.to_vec())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Directory a recorded trace should be written to.
///
/// Traces live under the **Copilot session** that produced them
/// (`~/.copilot/session-state/<id>/files/traces/`), not in the repo. A trace is
/// a personal, disposable reading aid: writing it into the working tree
/// pollutes every repo the user opens, shows up in `git status`, and risks
/// being committed. Losing traces when a session ends is an accepted trade —
/// re-recording takes seconds.
///
/// Falls back to `~/.copilot/traces/` when there is no session (no linked
/// Copilot session, or the session folder has not been created yet), because
/// refusing to record would be worse than storing it slightly less tidily.
pub fn trace_output_dir(home: &Path, session_id: Option<&str>) -> std::path::PathBuf {
    match session_id.filter(|id| !id.is_empty()) {
        Some(id) => home
            .join(".copilot")
            .join("session-state")
            .join(id)
            .join("files")
            .join("traces"),
        None => home.join(".copilot").join("traces"),
    }
}

/// Format a UNIX timestamp as an ISO-8601 UTC instant.
///
/// The trace format is shared with `scripts/trace-record.mjs`, which writes
/// `new Date().toISOString()`. The app's global `now()` returns epoch seconds,
/// so using it here produced traces whose `recordedAt` rendered as a raw number
/// and — worse — sorted inconsistently against CLI-recorded traces, since the
/// index orders by that string.
///
/// Implemented directly rather than pulling in `chrono` for one call, using the
/// standard civil-from-days algorithm.
pub fn format_iso8601(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let secs_of_day = unix_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Locate the Cargo manifest directory for a repo.
///
/// The manifest is often *not* at the repo root: a Tauri app keeps it in
/// `src-tauri/`, and plenty of mixed-language repos put the crate in a
/// subdirectory. Assuming the root made `cargo` fail with "could not find
/// Cargo.toml", which surfaced as an empty, unexplained test picker.
///
/// Checks the root first, then immediate subdirectories, preferring
/// conventional names so a workspace with several crates picks the obvious
/// one rather than whatever the filesystem happened to list first.
pub fn find_cargo_manifest_dir(repo_root: &str) -> Option<String> {
    let root = Path::new(repo_root);
    if root.join("Cargo.toml").is_file() {
        return Some(repo_root.to_string());
    }

    const PREFERRED: [&str; 4] = ["src-tauri", "rust", "backend", "src"];
    for name in PREFERRED {
        let candidate = root.join(name);
        if candidate.join("Cargo.toml").is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // Fall back to any immediate child, in a stable order so repeated calls
    // agree with each other.
    let mut children: Vec<String> = std::fs::read_dir(root)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.join("Cargo.toml").is_file())
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    children.sort();
    children.into_iter().next()
}

/// Diagnostic tracing of the DAP conversation, enabled with `WS_TRACE_DAP=1`.
/// Off by default so a normal recording stays quiet.
fn dap_trace(message: &str) {
    if std::env::var("WS_TRACE_DAP").is_ok() {
        eprintln!("[dap] {message}");
    }
}

/// Options for a recording run.
#[derive(Debug, Clone)]
pub struct RecordOptions {
    /// Fully-qualified test name, e.g. `pty::tests::resolves_shell`.
    pub test: String,
    /// Directory containing the crate's Cargo.toml.
    pub manifest_dir: String,
    /// Repo root; frames outside it are stepped over.
    pub repo_root: String,
    /// Max debugger steps before truncating.
    pub max_steps: u32,
}

/// A minimal DAP client over a child process's stdio.
struct DapSession {
    child: Child,
    stdin: std::process::ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    buffer: Vec<u8>,
    seq: u64,
    /// Messages seen while waiting for a different one.
    ///
    /// The adapter is free to emit `stopped` — or even the response to an
    /// earlier request — before the response we happen to be waiting on.
    /// Discarding non-matching messages loses them permanently and the next
    /// wait blocks forever, which is exactly what happened before this queue
    /// existed: the `launch` response arrived while we awaited
    /// `setFunctionBreakpoints`, so waiting for it afterwards never returned.
    pending: std::collections::VecDeque<serde_json::Value>,
}

impl DapSession {
    fn spawn(adapter: &str, env: Option<HashMap<String, String>>) -> Result<Self, String> {
        let mut cmd = Command::new(adapter);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(env) = env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Cannot start {adapter}: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin on lldb-dap")?;
        let stdout = child.stdout.take().ok_or("no stdout on lldb-dap")?;
        Ok(Self {
            child,
            stdin,
            reader: BufReader::new(stdout),
            buffer: Vec::new(),
            seq: 1,
            pending: std::collections::VecDeque::new(),
        })
    }

    fn send(&mut self, command: &str, arguments: serde_json::Value) -> Result<u64, String> {
        let seq = self.seq;
        self.seq += 1;
        let payload = serde_json::json!({
            "seq": seq, "type": "request", "command": command, "arguments": arguments,
        });
        self.stdin
            .write_all(&encode_dap_message(&payload))
            .map_err(|e| format!("DAP write failed: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("DAP flush failed: {e}"))?;
        Ok(seq)
    }

    /// Pump the stream until `predicate` matches a message, or the adapter
    /// closes. Anything that doesn't match is **queued rather than dropped**,
    /// so a message that arrives ahead of the one we are waiting on is still
    /// available later.
    fn wait_for(
        &mut self,
        mut predicate: impl FnMut(&serde_json::Value) -> bool,
    ) -> Result<serde_json::Value, String> {
        // Something already queued may be what the caller wants.
        if let Some(pos) = self.pending.iter().position(&mut predicate) {
            return Ok(self.pending.remove(pos).expect("index just found"));
        }
        loop {
            let (messages, rest) = read_dap_messages(&self.buffer);
            self.buffer = rest;
            for msg in messages {
                dap_trace(&format!(
                    "<- {} {}",
                    msg.get("type").and_then(|t| t.as_str()).unwrap_or("?"),
                    msg.get("command")
                        .or_else(|| msg.get("event"))
                        .and_then(|c| c.as_str())
                        .unwrap_or("?")
                ));
                if predicate(&msg) {
                    return Ok(msg);
                }
                self.pending.push_back(msg);
            }
            let mut chunk = [0u8; 8192];
            match self.reader.read(&mut chunk) {
                Ok(0) => return Err("lldb-dap closed the connection".to_string()),
                Ok(n) => self.buffer.extend_from_slice(&chunk[..n]),
                Err(e) => return Err(format!("DAP read failed: {e}")),
            }
        }
    }

    /// Forget queued messages. Called before each step so a `stopped` left
    /// over from the *previous* step cannot be mistaken for the next one's,
    /// and so the queue cannot grow without bound over a long recording.
    fn clear_pending(&mut self) {
        self.pending.clear();
    }

    fn request(
        &mut self,
        command: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        dap_trace(&format!("-> {command}"));
        let seq = self.send(command, arguments)?;
        let response = self.wait_for(|m| {
            m.get("type").and_then(|t| t.as_str()) == Some("response")
                && m.get("request_seq").and_then(|s| s.as_u64()) == Some(seq)
        })?;
        if response.get("success").and_then(|s| s.as_bool()) != Some(true) {
            let message = response
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("request failed");
            return Err(format!("{command}: {message}"));
        }
        Ok(response
            .get("body")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    fn wait_for_event(&mut self, event: &str) -> Result<serde_json::Value, String> {
        let msg = self.wait_for(|m| {
            m.get("type").and_then(|t| t.as_str()) == Some("event")
                && m.get("event").and_then(|e| e.as_str()) == Some(event)
        })?;
        Ok(msg.get("body").cloned().unwrap_or(serde_json::Value::Null))
    }
}

impl Drop for DapSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Locate `lldb-dap`, preferring Xcode's copy on macOS and falling back to PATH.
fn resolve_lldb_dap(env: &Option<HashMap<String, String>>) -> Result<String, String> {
    let path_override = env.as_ref().and_then(|e| e.get("PATH").cloned());

    let mut xcrun = Command::new("xcrun");
    xcrun.args(["-f", "lldb-dap"]);
    if let Some(p) = &path_override {
        xcrun.env("PATH", p);
    }
    if let Ok(out) = xcrun.output() {
        if out.status.success() {
            let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !found.is_empty() {
                return Ok(found);
            }
        }
    }

    let mut which = Command::new("which");
    which.arg("lldb-dap");
    if let Some(p) = &path_override {
        which.env("PATH", p);
    }
    if let Ok(out) = which.output() {
        if out.status.success() {
            let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !found.is_empty() {
                return Ok(found);
            }
        }
    }

    Err(
        "lldb-dap not found. On macOS install Xcode or the Command Line Tools; \
         elsewhere install LLDB and put lldb-dap on PATH."
            .to_string(),
    )
}

fn current_commit_sha(repo_root: &str) -> String {
    Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Record a trace. `env` supplies the repaired PATH so `cargo`, `git` and the
/// debug adapter resolve even when the app was launched from the Dock (see
/// ADR 017 — a GUI launch inherits launchd's stunted PATH).
pub fn record_trace(
    opts: &RecordOptions,
    env: Option<HashMap<String, String>>,
    mut on_progress: impl FnMut(&str, u32),
) -> Result<TraceFile, String> {
    on_progress("building test binary", 0);
    let mut cargo = Command::new("cargo");
    cargo
        .args(["test", "--no-run", "--message-format=json"])
        .current_dir(&opts.manifest_dir);
    if let Some(env) = &env {
        for (k, v) in env {
            cargo.env(k, v);
        }
    }
    let build = cargo
        .output()
        .map_err(|e| format!("Cannot run cargo in {}: {e}", opts.manifest_dir))?;
    if !build.status.success() {
        let stderr = String::from_utf8_lossy(&build.stderr);
        return Err(format!(
            "cargo test --no-run failed: {}",
            stderr.lines().last().unwrap_or("").trim()
        ));
    }
    let exe = select_test_executable(&String::from_utf8_lossy(&build.stdout))?;

    let adapter = resolve_lldb_dap(&env)?;
    on_progress("starting debugger", 0);
    let mut dap = DapSession::spawn(&adapter, env)?;

    dap.request(
        "initialize",
        serde_json::json!({
            "clientID": "workstreams",
            "adapterID": "lldb",
            "linesStartAt1": true,
            "columnsStartAt1": true,
            "pathFormat": "path",
        }),
    )?;

    // `--exact` avoids running neighbouring tests whose frames would
    // interleave; `--test-threads=1` makes the step order deterministic.
    let launch_seq = dap.send(
        "launch",
        serde_json::json!({
            "program": exe,
            "args": ["--exact", opts.test, "--test-threads=1", "--nocapture"],
            "cwd": opts.manifest_dir,
            "stopOnEntry": false,
            "env": { "RUST_BACKTRACE": "0" },
        }),
    )?;

    // Breaking on the *function* avoids having to know which line the test
    // body starts on.
    let bp = dap.request(
        "setFunctionBreakpoints",
        serde_json::json!({ "breakpoints": [{ "name": opts.test }] }),
    )?;
    let verified = bp
        .get("breakpoints")
        .and_then(|b| b.as_array())
        .map(|list| {
            list.iter()
                .any(|b| b.get("verified").and_then(|v| v.as_bool()) != Some(false))
        })
        .unwrap_or(false);
    if !verified {
        return Err(format!(
            "no breakpoint could be set on '{}'. The test name must be fully \
             qualified, e.g. `pty::tests::resolves_shell`.",
            opts.test
        ));
    }

    dap.request("configurationDone", serde_json::json!({}))?;
    let _ = dap.wait_for(|m| {
        m.get("type").and_then(|t| t.as_str()) == Some("response")
            && m.get("request_seq").and_then(|s| s.as_u64()) == Some(launch_seq)
    });

    on_progress("stepping", 0);
    let stopped = dap.wait_for_event("stopped")?;
    let thread_id = stopped
        .get("threadId")
        .and_then(|t| t.as_u64())
        .unwrap_or(1);

    let mut steps: Vec<TraceStep> = Vec::new();
    let mut truncated = false;

    for i in 0..opts.max_steps {
        let frames = match dap.request(
            "stackTrace",
            // `levels: 0` asks for the whole stack. lldb-dap only reports a
            // correct frame count that way — with `levels: 1` its `totalFrames`
            // is a stale constant — and the count is what makes "step out"
            // exact rather than a name-matching heuristic.
            serde_json::json!({ "threadId": thread_id, "startFrame": 0, "levels": 0 }),
        ) {
            Ok(body) => body,
            Err(_) => break, // process exited — the test finished
        };
        let Some(stack) = frames.get("stackFrames").and_then(|f| f.as_array()) else {
            break;
        };
        let depth = stack.len() as u32;
        let Some(frame) = stack.first() else {
            break;
        };

        let file = frame
            .get("source")
            .and_then(|s| s.get("path"))
            .and_then(|p| p.as_str());
        let ours = is_our_code(file, &opts.repo_root);

        if ours {
            if let Some(file) = file {
                let relative = Path::new(file)
                    .strip_prefix(&opts.repo_root)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| file.to_string());
                append_step(
                    &mut steps,
                    TraceStep {
                        file: relative,
                        line: frame.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32,
                        function: demangle(frame.get("name").and_then(|n| n.as_str())),
                        hits: None,
                        depth: Some(depth),
                    },
                );
                if steps.len().is_multiple_of(10) {
                    on_progress("stepping", steps.len() as u32);
                }
            }
        }

        // Descend into our own code; retreat from everyone else's.
        let command = if ours { "stepIn" } else { "stepOut" };
        dap.clear_pending();
        if dap
            .request(command, serde_json::json!({ "threadId": thread_id }))
            .is_err()
        {
            break;
        }
        if dap.wait_for_event("stopped").is_err() {
            break; // stepping ended (test returned, process exited)
        }

        if i == opts.max_steps - 1 {
            truncated = true;
        }
    }

    let _ = dap.request(
        "disconnect",
        serde_json::json!({ "terminateDebuggee": true }),
    );

    Ok(TraceFile {
        version: TRACE_FORMAT_VERSION,
        test: opts.test.clone(),
        repo_root: opts.repo_root.clone(),
        commit_sha: current_commit_sha(&opts.repo_root),
        recorded_at: format_iso8601(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        ),
        truncated,
        steps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(line: u32, function: &str, file: &str) -> TraceStep {
        TraceStep {
            file: file.to_string(),
            line,
            function: function.to_string(),
            hits: None,
            depth: None,
        }
    }

    #[test]
    fn selects_the_lib_test_binary_from_cargo_output() {
        // Unit tests live in the lib target, so picking the first candidate
        // would often trace the wrong binary.
        let out = format!(
            "{}\n{}\n",
            r#"{"target":{"name":"workstreams"},"profile":{"test":true},"executable":"/t/bin"}"#,
            r#"{"target":{"name":"workstreams_lib"},"profile":{"test":true},"executable":"/t/lib"}"#
        );
        assert_eq!(select_test_executable(&out).unwrap(), "/t/lib");
    }

    #[test]
    fn ignores_non_json_noise_from_cargo() {
        let out = format!(
            "   Compiling workstreams v0.2.0\n{}\n    Finished `test` profile\n",
            r#"{"target":{"name":"x_lib"},"profile":{"test":true},"executable":"/t/x"}"#
        );
        assert_eq!(select_test_executable(&out).unwrap(), "/t/x");
    }

    #[test]
    fn reports_an_actionable_error_when_no_test_binary_was_built() {
        assert!(select_test_executable("")
            .unwrap_err()
            .contains("no test executable"));
        let non_test = r#"{"target":{"name":"x"},"profile":{"test":false},"executable":"/t/x"}"#;
        assert!(select_test_executable(non_test)
            .unwrap_err()
            .contains("no test executable"));
    }

    #[test]
    fn recognises_files_inside_the_repo() {
        assert!(is_our_code(Some("/repo/src/pty.rs"), "/repo"));
    }

    #[test]
    fn rejects_std_frames_and_generated_code() {
        // This is the step-out trigger; without it a trivial assert descends
        // into thousands of frames of formatting machinery.
        assert!(!is_our_code(
            Some("/rustc/abc/library/core/src/ops.rs"),
            "/repo"
        ));
        assert!(!is_our_code(
            Some("/repo/target/debug/build/out.rs"),
            "/repo"
        ));
    }

    #[test]
    fn rejects_a_sibling_directory_with_the_same_prefix() {
        assert!(!is_our_code(Some("/repo-other/src/x.rs"), "/repo"));
    }

    #[test]
    fn rejects_a_frame_with_no_source_path() {
        // DAP omits `source.path` for frames with no debug info.
        assert!(!is_our_code(None, "/repo"));
        assert!(!is_our_code(Some(""), "/repo"));
    }

    #[test]
    fn demangles_the_rustc_hash_suffix() {
        assert_eq!(
            demangle(Some("workstreams_lib::pty::resolve::h883e38d7c33f09e0")),
            "workstreams_lib::pty::resolve"
        );
        assert_eq!(demangle(Some("main")), "main");
        assert_eq!(demangle(None), "");
    }

    #[test]
    fn collapses_consecutive_identical_locations() {
        let mut steps = Vec::new();
        for _ in 0..3 {
            append_step(&mut steps, step(154, "f", "a.rs"));
        }
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].hits, Some(3));
    }

    #[test]
    fn omits_hits_for_a_single_visit() {
        let mut steps = Vec::new();
        append_step(&mut steps, step(1, "f", "a.rs"));
        assert_eq!(steps[0].hits, None);
    }

    #[test]
    fn preserves_loop_revisits() {
        // 52 -> 53 -> 52 is a real iteration; only *consecutive* duplicates are
        // debugger mechanics. Collapsing these would erase the execution order
        // that is the whole point of the feature.
        let mut steps = Vec::new();
        for line in [52, 53, 52, 53, 52] {
            append_step(&mut steps, step(line, "f", "a.rs"));
        }
        assert_eq!(
            steps.iter().map(|s| s.line).collect::<Vec<_>>(),
            vec![52, 53, 52, 53, 52]
        );
    }

    #[test]
    fn does_not_collapse_the_same_line_in_a_different_scope() {
        // Recursion and macro expansion make this real.
        let mut steps = Vec::new();
        append_step(&mut steps, step(10, "outer", "a.rs"));
        append_step(&mut steps, step(10, "inner", "a.rs"));
        append_step(&mut steps, step(10, "inner", "b.rs"));
        assert_eq!(steps.len(), 3);
    }

    #[test]
    fn encodes_content_length_in_bytes_not_characters() {
        // A non-ASCII path in an argument would desync the stream if we used
        // character length.
        let payload = serde_json::json!({ "path": "/tmp/café/ünïcode" });
        let encoded = encode_dap_message(&payload);
        let text = String::from_utf8_lossy(&encoded);
        let (header, body) = text.split_once("\r\n\r\n").unwrap();
        let declared: usize = header
            .trim_start_matches("Content-Length:")
            .trim()
            .parse()
            .unwrap();
        assert_eq!(declared, body.len());
        assert!(declared > body.chars().count());
    }

    #[test]
    fn reads_a_single_complete_frame() {
        let encoded = encode_dap_message(&serde_json::json!({ "seq": 1 }));
        let (messages, rest) = read_dap_messages(&encoded);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["seq"], 1);
        assert!(rest.is_empty());
    }

    #[test]
    fn holds_back_a_frame_split_across_reads() {
        // stdout arrives in arbitrary chunks; a naive parser loses messages.
        let encoded = encode_dap_message(&serde_json::json!({ "seq": 7 }));
        let split = encoded.len() / 2;
        let (messages, rest) = read_dap_messages(&encoded[..split]);
        assert!(messages.is_empty());
        assert_eq!(rest.len(), split);

        let mut combined = rest;
        combined.extend_from_slice(&encoded[split..]);
        let (messages, rest) = read_dap_messages(&combined);
        assert_eq!(messages.len(), 1);
        assert!(rest.is_empty());
    }

    #[test]
    fn reads_several_frames_from_one_buffer() {
        let mut buffer = Vec::new();
        for seq in 1..=3 {
            buffer.extend_from_slice(&encode_dap_message(&serde_json::json!({ "seq": seq })));
        }
        let (messages, _) = read_dap_messages(&buffer);
        assert_eq!(
            messages
                .iter()
                .map(|m| m["seq"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn skips_a_malformed_body_without_stalling_the_stream() {
        let mut buffer = b"Content-Length: 3\r\n\r\n{{{".to_vec();
        buffer.extend_from_slice(&encode_dap_message(&serde_json::json!({ "seq": 9 })));
        let (messages, _) = read_dap_messages(&buffer);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["seq"], 9);
    }

    #[test]
    fn a_buffer_yields_messages_in_arrival_order() {
        // Ordering matters for the queue: a response that arrives ahead of the
        // one being awaited must still be findable afterwards, which only
        // works if reads preserve order.
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&encode_dap_message(
            &serde_json::json!({ "type": "response", "command": "launch", "request_seq": 2 }),
        ));
        buffer.extend_from_slice(&encode_dap_message(
            &serde_json::json!({ "type": "event", "event": "stopped" }),
        ));
        let (messages, _) = read_dap_messages(&buffer);
        assert_eq!(messages[0]["command"], "launch");
        assert_eq!(messages[1]["event"], "stopped");
    }

    #[test]
    fn writes_traces_under_the_owning_session() {
        // Not into the repo: a trace is a personal reading aid, and writing it
        // into the working tree pollutes git status in every repo opened.
        let dir = trace_output_dir(Path::new("/home/me"), Some("sess-1"));
        assert_eq!(
            dir,
            Path::new("/home/me/.copilot/session-state/sess-1/files/traces")
        );
    }

    #[test]
    fn falls_back_when_there_is_no_session() {
        // Refusing to record would be worse than storing it less tidily.
        let expected = Path::new("/home/me/.copilot/traces");
        assert_eq!(trace_output_dir(Path::new("/home/me"), None), expected);
        assert_eq!(trace_output_dir(Path::new("/home/me"), Some("")), expected);
    }

    #[test]
    fn trace_dir_never_touches_the_repo() {
        let dir = trace_output_dir(Path::new("/home/me"), Some("sess-1"));
        assert!(!dir.to_string_lossy().contains(".workstreams"));
    }

    #[test]
    fn formats_a_timestamp_as_iso8601() {
        // The trace format is shared with the Node CLI, which writes
        // toISOString(); epoch seconds would render as a raw number and sort
        // inconsistently against CLI-recorded traces.
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso8601(1_786_466_376), "2026-08-11T16:39:36.000Z");
    }

    #[test]
    fn iso8601_handles_leap_years() {
        // 2024-02-29T12:00:00Z
        assert_eq!(format_iso8601(1_709_208_000), "2024-02-29T12:00:00.000Z");
    }

    #[test]
    fn iso8601_sorts_lexicographically_in_time_order() {
        // The trace index orders by this string, so lexicographic order must
        // match chronological order.
        let earlier = format_iso8601(1_700_000_000);
        let later = format_iso8601(1_800_000_000);
        assert!(earlier < later, "{earlier} should sort before {later}");
    }

    #[test]
    fn finds_a_manifest_at_the_repo_root() {
        let dir = std::env::temp_dir().join(format!("ws-manifest-root-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]").unwrap();
        let found = find_cargo_manifest_dir(&dir.to_string_lossy());
        assert_eq!(found.as_deref(), Some(dir.to_string_lossy().as_ref()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_a_manifest_in_src_tauri() {
        // The case that broke the picker: a Tauri repo keeps its crate in
        // src-tauri/, so cargo at the root fails outright.
        let dir = std::env::temp_dir().join(format!("ws-manifest-tauri-{}", std::process::id()));
        let crate_dir = dir.join("src-tauri");
        std::fs::create_dir_all(&crate_dir).unwrap();
        std::fs::write(crate_dir.join("Cargo.toml"), "[package]").unwrap();
        let found = find_cargo_manifest_dir(&dir.to_string_lossy());
        assert_eq!(found.as_deref(), Some(crate_dir.to_string_lossy().as_ref()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prefers_the_root_manifest_over_a_child() {
        let dir = std::env::temp_dir().join(format!("ws-manifest-both-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src-tauri")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[workspace]").unwrap();
        std::fs::write(dir.join("src-tauri").join("Cargo.toml"), "[package]").unwrap();
        let found = find_cargo_manifest_dir(&dir.to_string_lossy());
        assert_eq!(found.as_deref(), Some(dir.to_string_lossy().as_ref()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn returns_none_for_a_repo_with_no_rust() {
        // The picker must say so rather than showing an empty dropdown.
        let dir = std::env::temp_dir().join(format!("ws-manifest-none-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        assert_eq!(find_cargo_manifest_dir(&dir.to_string_lossy()), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn serialised_steps_omit_hits_when_absent() {
        // v1 readers treat a missing field as "not captured"; emitting nulls
        // would bloat every trace.
        let json = serde_json::to_string(&step(1, "f", "a.rs")).unwrap();
        assert!(!json.contains("hits"), "got {json}");
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// End-to-end against the real debugger. Ignored by default because it
    /// needs `lldb-dap` + a full cargo build; run explicitly with
    /// `cargo test --lib -- --ignored records_a_real_trace`.
    #[test]
    #[ignore]
    fn records_a_real_trace() {
        let repo = std::env::current_dir()
            .unwrap()
            .parent()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let opts = RecordOptions {
            test: "shell_env::tests::merge_drops_empty_segments".to_string(),
            manifest_dir: format!("{repo}/src-tauri"),
            repo_root: repo,
            max_steps: 200,
        };
        let trace = record_trace(&opts, None, |phase, n| eprintln!("[{phase}] {n}")).unwrap();
        eprintln!("recorded {} steps", trace.steps.len());
        assert!(
            !trace.steps.is_empty(),
            "expected steps from a real recording"
        );
        assert!(trace.steps.iter().all(|s| s.line > 0));
        assert!(trace.steps.iter().any(|s| s.file.contains("shell_env.rs")));
        // Depth is what makes "step out" exact, so a real recording must carry
        // it — and must show the stack actually moving.
        assert!(
            trace.steps.iter().all(|s| s.depth.is_some()),
            "every step needs a depth"
        );
        let depths: Vec<u32> = trace.steps.iter().filter_map(|s| s.depth).collect();
        let min = depths.iter().min().unwrap();
        let max = depths.iter().max().unwrap();
        assert!(max > min, "expected nesting, got constant depth {min}");
        eprintln!("depth range: {min}..={max}");
    }
}
