//! Headless periodic runs (ADR 046): one non-interactive Copilot CLI call per run.
//!
//! A run starts the workspace's configured Copilot command as it is, plus
//! `-p <prompt> --session-id=<S>|--resume=<S> --no-ask-user --output-format json`,
//! as a plain child process (no PTY) in the workstream's directory. Its stdout
//! is JSONL (one event per line); every line is kept in the run's events file
//! and folded into the run's tool calls and final answer as it arrives. A run
//! always ends with one result: ok, failed, timed out (killed after 60
//! minutes, by its own process group), or needs input (the final answer starts
//! with `NEEDS INPUT:`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const RUN_TIMEOUT_MS: u64 = 60 * 60 * 1000;
pub const NEEDS_INPUT_MARKER: &str = "NEEDS INPUT:";
/// Appended to every run's prompt; the same text as `NEEDS_INPUT_INSTRUCTION`
/// in `src/domain/periodic-schedules.ts`.
pub const NEEDS_INPUT_INSTRUCTION: &str = "(From Workstreams: this run is unattended and nobody can answer you during it. If you need a decision or information from the user before you can go on, do not guess: stop, and begin your final reply with NEEDS INPUT: followed by your question.)";
const DEFAULT_COMMAND: &str = "agency copilot --yolo";
const STDERR_TAIL: usize = 4000;

/// What a run sends: the prompt, then the needs-input instruction.
pub fn compose_prompt(prompt: &str) -> String {
    format!("{prompt}\n\n{NEEDS_INPUT_INSTRUCTION}")
}

/// Program and argv of a headless run. The command template is whitespace-
/// split (a setting, not user text); the prompt is one argv entry, never
/// passed through a shell. The first run creates the session with
/// `--session-id`, later ones resume it.
pub fn headless_argv(
    command: Option<&str>,
    prompt: &str,
    session_id: &str,
    first_run: bool,
) -> Result<(String, Vec<String>), String> {
    let template = command
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_COMMAND);
    let mut parts = template.split_whitespace();
    let program = parts
        .next()
        .ok_or("The Copilot command is empty.")?
        .to_string();
    let mut args: Vec<String> = parts.map(str::to_string).collect();
    args.push("-p".into());
    args.push(prompt.to_string());
    args.push(if first_run {
        format!("--session-id={session_id}")
    } else {
        format!("--resume={session_id}")
    });
    args.extend(["--no-ask-user", "--output-format", "json"].map(String::from));
    Ok((program, args))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// running, ok or failed.
    pub status: String,
}

/// Folds the CLI's JSONL events into what a run shows. Unknown events and
/// lines that aren't JSON are ignored (kept as plain text for a fallback
/// answer), so a new CLI version can only add, not break.
#[derive(Debug, Default)]
pub struct RunParser {
    pub tools: Vec<ToolCall>,
    answer: Option<String>,
    final_seen: bool,
    pub session_started: bool,
    saw_json: bool,
    plain: String,
}

impl RunParser {
    /// Reads one stdout line; true when what the run shows changed.
    pub fn ingest(&mut self, line: &str) -> bool {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            if !line.trim().is_empty() {
                if !self.plain.is_empty() {
                    self.plain.push('\n');
                }
                self.plain.push_str(line.trim_end());
            }
            return false;
        };
        self.saw_json = true;
        let data = &event["data"];
        let text = |key: &str| data[key].as_str().unwrap_or_default().to_string();
        match event["type"].as_str().unwrap_or_default() {
            "session.start" => {
                self.session_started = true;
                false
            }
            "result" => {
                self.session_started |= event["sessionId"].is_string();
                false
            }
            "tool.execution_start" => {
                let id = text("toolCallId");
                if id.is_empty() {
                    return false;
                }
                self.tools.push(ToolCall {
                    id,
                    name: text("toolName"),
                    status: "running".into(),
                });
                true
            }
            "tool.execution_complete" => {
                let id = text("toolCallId");
                if id.is_empty() {
                    return false;
                }
                let status = if data["success"].as_bool().unwrap_or(false) {
                    "ok"
                } else {
                    "failed"
                };
                match self.tools.iter_mut().find(|t| t.id == id) {
                    Some(tool) => tool.status = status.into(),
                    None => self.tools.push(ToolCall {
                        id,
                        name: text("toolName"),
                        status: status.into(),
                    }),
                }
                true
            }
            "assistant.message" => {
                let content = text("content");
                if content.trim().is_empty() || self.final_seen {
                    return false;
                }
                self.final_seen = data["phase"].as_str() == Some("final_answer");
                self.answer = Some(content);
                true
            }
            _ => false,
        }
    }

    /// The final answer: the last assistant message (its final-answer phase
    /// wins), or the plain text when the output wasn't JSON at all.
    pub fn answer(&self) -> Option<String> {
        self.answer.clone().or_else(|| {
            (!self.saw_json && !self.plain.trim().is_empty()).then(|| self.plain.trim().to_string())
        })
    }
}

/// The question of a needs-input answer, or None.
pub fn needs_input_question(answer: &str) -> Option<String> {
    let strip = |text: &str| -> String {
        text.trim_start_matches(|c: char| c.is_whitespace() || c == '*' || c == '_')
            .to_string()
    };
    let rest = strip(answer);
    let question = rest.strip_prefix(NEEDS_INPUT_MARKER)?;
    Some(strip(question).trim_end().to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub enum Exit {
    Code(i32),
    /// Killed by a signal (no exit code).
    Signal,
    SpawnError(String),
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunOutcome {
    /// ok, failed, timed_out or needs_input.
    pub status: String,
    pub exit_code: Option<i32>,
    pub answer: Option<String>,
    pub question: Option<String>,
    pub error: Option<String>,
    pub tools: Vec<ToolCall>,
    pub session_started: bool,
}

/// The one result a finished run gets.
pub fn classify(exit: &Exit, parser: &RunParser, stderr: &str) -> RunOutcome {
    let answer = parser.answer();
    let tail = stderr.trim();
    let with_stderr = |text: String| {
        if tail.is_empty() {
            text
        } else {
            format!("{text}: {tail}")
        }
    };
    let (status, exit_code, question, error) = match exit {
        Exit::Code(0) => match answer.as_deref().and_then(needs_input_question) {
            Some(question) => ("needs_input", Some(0), Some(question), None),
            None => ("ok", Some(0), None, None),
        },
        Exit::Code(code) => (
            "failed",
            Some(*code),
            None,
            Some(with_stderr(format!("The run ended with exit code {code}"))),
        ),
        Exit::Signal => (
            "failed",
            None,
            None,
            Some(with_stderr("The run was killed".to_string())),
        ),
        Exit::SpawnError(error) => (
            "failed",
            None,
            None,
            Some(format!("The Copilot command could not start: {error}")),
        ),
        Exit::TimedOut => (
            "timed_out",
            None,
            None,
            Some("The run was still going after 60 minutes, so it was stopped.".to_string()),
        ),
    };
    RunOutcome {
        status: status.into(),
        exit_code,
        answer,
        question,
        error,
        tools: parser.tools.clone(),
        session_started: parser.session_started,
    }
}

/// What a run starts.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

/// Starts a run's process; tests substitute a fake.
pub trait Launcher: Send + Sync {
    fn launch(&self, spec: &LaunchSpec) -> std::io::Result<Child>;
}

/// The real launcher: a plain child process in its own process group, with
/// piped output, no stdin, and the login shell's PATH.
pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    fn launch(&self, spec: &LaunchSpec) -> std::io::Result<Child> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = crate::shell_env::resolved_path(&crate::pty::default_shell()) {
            command.env("PATH", path);
        }
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        command.spawn()
    }
}

/// Time for the run loop; tests use a fake one to reach the timeout at once.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
    /// How long to wait for output between checks.
    fn poll(&self) -> Duration;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default()
    }
    fn poll(&self) -> Duration {
        Duration::from_millis(200)
    }
}

/// Kills a run's process and everything it started, by its own process
/// group (Unix) or process tree (Windows); never by name.
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        // The run is its group's leader (process_group(0)): -pid is that group.
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .status();
    }
}

/// What a run reports while it goes.
#[derive(Debug, Clone)]
pub enum Progress {
    Spawned(u32),
    /// The tool calls or the answer changed.
    Changed {
        tools: Vec<ToolCall>,
        answer: Option<String>,
    },
}

/// Runs one headless call to its end and returns its result. Each stdout
/// line is appended to `events` (when given) and folded into the progress.
pub fn execute(
    launcher: &dyn Launcher,
    clock: &dyn Clock,
    spec: &LaunchSpec,
    timeout_ms: u64,
    events: Option<&Path>,
    on_progress: &mut dyn FnMut(Progress),
) -> RunOutcome {
    let mut parser = RunParser::default();
    let mut child = match launcher.launch(spec) {
        Ok(child) => child,
        Err(error) => return classify(&Exit::SpawnError(error.to_string()), &parser, ""),
    };
    let pid = child.id();
    on_progress(Progress::Spawned(pid));
    let started = clock.now_ms();
    let mut file = events.and_then(|path| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
    });
    let (tx, rx) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    } else {
        drop(tx);
    }
    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(mut pipe) = child.stderr.take() {
        let sink = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut text = sink.lock().unwrap();
                text.push_str(&String::from_utf8_lossy(&buf[..n]));
                if text.len() > STDERR_TAIL * 2 {
                    let cut = text.len() - STDERR_TAIL;
                    let cut = (cut..text.len())
                        .find(|i| text.is_char_boundary(*i))
                        .unwrap_or(0);
                    text.drain(..cut);
                }
            }
        });
    }
    let mut take = |line: String, parser: &mut RunParser| {
        if let Some(file) = file.as_mut() {
            let _ = writeln!(file, "{line}");
        }
        if parser.ingest(&line) {
            on_progress(Progress::Changed {
                tools: parser.tools.clone(),
                answer: parser.answer(),
            });
        }
    };
    let exit = loop {
        match rx.recv_timeout(clock.poll()) {
            Ok(line) => {
                take(line, &mut parser);
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.code().map(Exit::Code).unwrap_or(Exit::Signal),
            Ok(None) => {}
            Err(error) => break Exit::SpawnError(error.to_string()),
        }
        if clock.now_ms().saturating_sub(started) >= timeout_ms {
            kill_tree(pid);
            let _ = child.wait();
            break Exit::TimedOut;
        }
        // Output closed but the process lingers: don't spin.
        if matches!(rx.try_recv(), Err(mpsc::TryRecvError::Disconnected)) {
            std::thread::sleep(clock.poll());
        }
    };
    // What the process printed before it ended; a grandchild holding the pipe
    // open doesn't hold the run.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) => take(line, &mut parser),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // The run itself was reaped: only its group is left to stop.
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
                break;
            }
        }
    }
    let text = stderr.lock().map(|s| s.clone()).unwrap_or_default();
    let cut = (text.len().saturating_sub(STDERR_TAIL)..=text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(text.len());
    classify(&exit, &parser, &text[cut..])
}

/// The runs going now, one per tile, so a second can't start and every one
/// can be killed when the app exits.
#[derive(Default)]
pub struct RunManager {
    active: Mutex<HashMap<String, (String, Option<u32>)>>,
}

impl RunManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claims the tile for `run_id`; refused while another run holds it.
    pub fn reserve(&self, tile_id: &str, run_id: &str) -> Result<(), String> {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(tile_id) {
            return Err("A run is already going in this tile.".into());
        }
        active.insert(tile_id.to_string(), (run_id.to_string(), None));
        Ok(())
    }

    pub fn set_pid(&self, tile_id: &str, pid: u32) {
        if let Some(entry) = self.active.lock().unwrap().get_mut(tile_id) {
            entry.1 = Some(pid);
        }
    }

    pub fn release(&self, tile_id: &str, run_id: &str) {
        let mut active = self.active.lock().unwrap();
        if active.get(tile_id).is_some_and(|(id, _)| id == run_id) {
            active.remove(tile_id);
        }
    }

    pub fn is_running(&self, tile_id: &str) -> bool {
        self.active.lock().unwrap().contains_key(tile_id)
    }

    pub fn kill_all(&self) {
        for (_, pid) in self.active.lock().unwrap().values() {
            if let Some(pid) = pid {
                kill_tree(*pid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_run_creates_the_session_and_later_ones_resume_it() {
        let (program, args) =
            headless_argv(Some("my-copilot --yolo --model x"), "P", "S", true).unwrap();
        assert_eq!(program, "my-copilot");
        assert_eq!(
            args,
            vec![
                "--yolo",
                "--model",
                "x",
                "-p",
                "P",
                "--session-id=S",
                "--no-ask-user",
                "--output-format",
                "json"
            ]
        );
        let (_, args) =
            headless_argv(Some("my-copilot --yolo --model x"), "P", "S", false).unwrap();
        assert!(args.contains(&"--resume=S".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("--session-id")));
        // Blank: the built-in default command.
        let (program, args) = headless_argv(Some("  "), "P", "S", true).unwrap();
        assert_eq!(
            (program.as_str(), &args[..2]),
            ("agency", &["copilot".to_string(), "--yolo".to_string()][..])
        );
    }

    #[test]
    fn the_prompt_is_one_argument_and_carries_the_needs_input_instruction() {
        let prompt = compose_prompt("Fix it\nthen \"say\" $(whoami)");
        assert!(prompt.starts_with("Fix it\nthen \"say\" $(whoami)\n\n"));
        assert!(prompt.ends_with(NEEDS_INPUT_INSTRUCTION));
        assert!(NEEDS_INPUT_INSTRUCTION.contains("NEEDS INPUT:"));
        let (_, args) = headless_argv(None, &prompt, "S", false).unwrap();
        let at = args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(args[at + 1], prompt);
    }

    /// The shape the real CLI (1.0.117) prints with `--output-format json`.
    const REAL: &str = r#"{"type":"session.start","data":{"sessionId":"S","context":{"cwd":"/w"}}}
{"type":"user.message","data":{"content":"Read a.txt"}}
{"type":"assistant.turn_start","data":{"turnId":"0"}}
{"type":"assistant.message","data":{"content":"","toolRequests":[{"toolCallId":"c1","name":"glob"}],"turnId":"0"}}
{"type":"tool.execution_start","data":{"toolCallId":"c1","toolName":"glob","arguments":{"pattern":"a.txt"}}}
{"type":"tool.execution_complete","data":{"toolCallId":"c1","success":true,"result":{"content":"./a.txt"}}}
{"type":"tool.execution_start","data":{"toolCallId":"c2","toolName":"bash","arguments":{}}}
{"type":"tool.execution_complete","data":{"toolCallId":"c2","success":false}}
{"type":"assistant.message_delta","data":{"deltaContent":"a.txt"}}
{"type":"assistant.message","data":{"content":"a.txt contains hello.","toolRequests":[],"phase":"final_answer"}}
{"type":"assistant.turn_end","data":{"turnId":"2"}}
{"type":"result","timestamp":"x","sessionId":"S","exitCode":0}"#;

    #[test]
    fn reads_tool_calls_and_the_final_answer_from_the_jsonl() {
        let mut parser = RunParser::default();
        let changed: Vec<bool> = REAL.lines().map(|l| parser.ingest(l)).collect();
        assert!(parser.session_started);
        assert_eq!(
            parser.tools,
            vec![
                ToolCall {
                    id: "c1".into(),
                    name: "glob".into(),
                    status: "ok".into()
                },
                ToolCall {
                    id: "c2".into(),
                    name: "bash".into(),
                    status: "failed".into()
                },
            ]
        );
        assert_eq!(parser.answer().as_deref(), Some("a.txt contains hello."));
        // Tool starts, completions and the answer are changes; deltas and the rest aren't.
        assert_eq!(changed.iter().filter(|c| **c).count(), 5);
    }

    #[test]
    fn the_parser_is_tolerant() {
        let mut parser = RunParser::default();
        assert!(!parser.ingest("not json"));
        assert!(!parser.ingest(r#"{"type":"something.new","data":{}}"#));
        assert!(!parser.ingest(r#"{"no":"type"}"#));
        assert!(!parser.ingest(r#"{"type":"tool.execution_complete"}"#));
        assert!(parser.ingest(r#"{"type":"assistant.message","data":{"content":"First"}}"#));
        assert!(!parser.ingest(r#"{"type":"assistant.message","data":{"content":""}}"#));
        assert_eq!(parser.answer().as_deref(), Some("First"));
        // A completion for a start it never saw still shows.
        assert!(parser.ingest(r#"{"type":"tool.execution_complete","data":{"toolCallId":"x","toolName":"view","success":true}}"#));
        assert_eq!(parser.tools[0].name, "view");
        // A final answer stays the answer.
        parser.ingest(
            r#"{"type":"assistant.message","data":{"content":"Final","phase":"final_answer"}}"#,
        );
        parser.ingest(r#"{"type":"assistant.message","data":{"content":"Later"}}"#);
        assert_eq!(parser.answer().as_deref(), Some("Final"));
        // Output that was never JSON: its text is the answer.
        let mut plain = RunParser::default();
        plain.ingest("Just text");
        plain.ingest("more");
        assert_eq!(plain.answer().as_deref(), Some("Just text\nmore"));
        assert_eq!(RunParser::default().answer(), None);
    }

    #[test]
    fn needs_input_is_an_explicit_prefix() {
        assert_eq!(
            needs_input_question("  \nNEEDS INPUT: Skip the flaky test or just report it?")
                .as_deref(),
            Some("Skip the flaky test or just report it?")
        );
        assert_eq!(
            needs_input_question("**NEEDS INPUT:** Which one?").as_deref(),
            Some("Which one?")
        );
        assert_eq!(needs_input_question("All green. NEEDS INPUT: no"), None);
        assert_eq!(needs_input_question("needs input: lower case"), None);
        assert_eq!(needs_input_question("NEEDS INPUT:").as_deref(), Some(""));
    }

    fn parsed(answer: Option<&str>) -> RunParser {
        let mut parser = RunParser::default();
        if let Some(text) = answer {
            parser.ingest(
                &serde_json::json!({"type":"assistant.message","data":{"content":text}})
                    .to_string(),
            );
        }
        parser
    }

    #[test]
    fn every_run_ends_with_exactly_one_result() {
        let ok = classify(&Exit::Code(0), &parsed(Some("All green")), "");
        assert_eq!(
            (ok.status.as_str(), ok.exit_code, ok.answer.as_deref()),
            ("ok", Some(0), Some("All green"))
        );
        let ask = classify(&Exit::Code(0), &parsed(Some("NEEDS INPUT: Which?")), "");
        assert_eq!(
            (ask.status.as_str(), ask.question.as_deref()),
            ("needs_input", Some("Which?"))
        );
        let failed = classify(
            &Exit::Code(1),
            &parsed(Some("NEEDS INPUT: x")),
            "Error: No session matched\n",
        );
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.exit_code, Some(1));
        assert!(failed.error.as_deref().unwrap().contains("exit code 1"));
        assert!(failed
            .error
            .as_deref()
            .unwrap()
            .contains("No session matched"));
        let spawn = classify(&Exit::SpawnError("No such file".into()), &parsed(None), "");
        assert_eq!(spawn.status, "failed");
        assert!(spawn.error.as_deref().unwrap().contains("No such file"));
        let killed = classify(&Exit::Signal, &parsed(None), "");
        assert_eq!(killed.status, "failed");
        let late = classify(&Exit::TimedOut, &parsed(Some("half")), "");
        assert_eq!(late.status, "timed_out");
        assert!(late.error.as_deref().unwrap().contains("60 minutes"));
    }

    #[test]
    fn a_tile_runs_one_run_at_a_time() {
        let manager = RunManager::new();
        manager.reserve("t", "r1").unwrap();
        assert!(manager.is_running("t"));
        assert!(manager.reserve("t", "r2").unwrap_err().contains("already"));
        manager.reserve("u", "r3").unwrap();
        manager.release("t", "other");
        assert!(manager.is_running("t"), "only its own run releases it");
        manager.release("t", "r1");
        assert!(!manager.is_running("t"));
        manager.reserve("t", "r2").unwrap();
    }

    #[cfg(unix)]
    mod process {
        use super::super::*;
        use super::REAL;
        use std::sync::atomic::{AtomicU64, Ordering};

        /// Records what the runner launched, and runs a shell script in its place.
        struct Fake {
            script: String,
            seen: Mutex<Vec<LaunchSpec>>,
        }

        impl Fake {
            fn new(script: &str) -> Self {
                Fake {
                    script: script.into(),
                    seen: Mutex::new(vec![]),
                }
            }
        }

        impl Launcher for Fake {
            fn launch(&self, spec: &LaunchSpec) -> std::io::Result<Child> {
                self.seen.lock().unwrap().push(spec.clone());
                let mut real = spec.clone();
                real.program = "sh".into();
                real.args = vec!["-c".into(), self.script.clone()];
                SystemLauncher.launch(&real)
            }
        }

        /// Each reading moves a minute on: 60 minutes pass in 60 polls.
        struct FastClock(AtomicU64);

        impl Clock for FastClock {
            fn now_ms(&self) -> u64 {
                self.0.fetch_add(60_000, Ordering::SeqCst)
            }
            fn poll(&self) -> Duration {
                Duration::from_millis(5)
            }
        }

        fn dir() -> std::path::PathBuf {
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/tmp")
                .join(format!("ws-run-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn spec(cwd: &Path) -> LaunchSpec {
            let (program, args) = headless_argv(Some("my-copilot --yolo"), "P", "S", true).unwrap();
            LaunchSpec {
                program,
                args,
                cwd: cwd.to_string_lossy().into(),
                env: vec![("WORKSTREAMS_ACTIVE_TILE".into(), "t1".into())],
            }
        }

        #[test]
        fn an_ok_run_streams_its_events_to_the_file_and_the_ui() {
            let dir = dir();
            let lines: Vec<String> = REAL.lines().map(|l| format!("echo '{l}'")).collect();
            let fake = Fake::new(&format!("{}; pwd > cwd.txt", lines.join("; ")));
            let events = dir.join("run.jsonl");
            let mut progress = vec![];
            let outcome = execute(
                &fake,
                &SystemClock,
                &spec(&dir),
                RUN_TIMEOUT_MS,
                Some(&events),
                &mut |p| progress.push(p),
            );
            assert_eq!(outcome.status, "ok");
            assert_eq!(outcome.answer.as_deref(), Some("a.txt contains hello."));
            assert!(outcome.session_started);
            assert_eq!(outcome.tools.len(), 2);
            // Launched once, in the workstream's directory, with its env.
            let seen = fake.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].program, "my-copilot");
            let cwd = std::fs::read_to_string(dir.join("cwd.txt")).unwrap();
            assert_eq!(
                std::fs::canonicalize(cwd.trim()).unwrap(),
                std::fs::canonicalize(&dir).unwrap()
            );
            // Every line kept; the UI saw the spawn, then each tool call, then the answer.
            assert_eq!(
                std::fs::read_to_string(&events).unwrap().lines().count(),
                REAL.lines().count()
            );
            assert!(matches!(progress[0], Progress::Spawned(_)));
            let Progress::Changed { tools, answer } = progress.last().unwrap() else {
                panic!()
            };
            assert_eq!(
                (tools.len(), answer.as_deref()),
                (2, Some("a.txt contains hello."))
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn a_failing_or_unstartable_run_is_failed() {
            let dir = dir();
            let fake = Fake::new("echo 'Error: nope' >&2; exit 3");
            let outcome = execute(
                &fake,
                &SystemClock,
                &spec(&dir),
                RUN_TIMEOUT_MS,
                None,
                &mut |_| {},
            );
            assert_eq!(
                (outcome.status.as_str(), outcome.exit_code),
                ("failed", Some(3))
            );
            assert!(outcome.error.unwrap().contains("Error: nope"));
            let mut missing = spec(&dir);
            missing.program = "/no/such/copilot".into();
            let outcome = execute(
                &SystemLauncher,
                &SystemClock,
                &missing,
                RUN_TIMEOUT_MS,
                None,
                &mut |_| {},
            );
            assert_eq!(
                (outcome.status.as_str(), outcome.exit_code),
                ("failed", None)
            );
            assert!(outcome.error.unwrap().contains("could not start"));
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn a_run_still_going_after_60_minutes_is_killed_and_timed_out() {
            let dir = dir();
            // The child writes its pid, then hangs (as a run waiting for input would).
            let fake = Fake::new("echo $$ > pid.txt; sleep 600");
            let mut pid = None;
            let outcome = execute(
                &fake,
                &FastClock(AtomicU64::new(0)),
                &spec(&dir),
                RUN_TIMEOUT_MS,
                None,
                &mut |p| {
                    if let Progress::Spawned(p) = p {
                        pid = Some(p)
                    }
                },
            );
            assert_eq!(outcome.status, "timed_out");
            let pid = pid.unwrap() as i32;
            // The process (and its group) is gone.
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            assert!(!alive, "the timed-out process is still alive");
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
