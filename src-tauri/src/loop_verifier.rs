use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct VerifierConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    pub output_limit_bytes: usize,
    pub cancelled: Option<Arc<AtomicBool>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Passed,
    NonZero,
    TimedOut,
    SpawnError,
    Cancelled,
}

impl VerificationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::NonZero => "nonzero",
            Self::TimedOut => "timed_out",
            Self::SpawnError => "spawn_error",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationResult {
    pub status: VerificationStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub program_hash: Option<String>,
}

fn hash_file(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

struct CapturedOutput {
    text: String,
    truncated: bool,
    error: Option<String>,
}

fn read_bounded<R: Read>(mut reader: R, limit: usize) -> CapturedOutput {
    let mut retained = Vec::with_capacity(limit.min(16 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8 * 1024];
    let error = loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break None,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                truncated = true;
                break Some(error.to_string());
            }
        };
        let remaining = limit.saturating_sub(retained.len());
        let keep = read.min(remaining);
        retained.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    };
    CapturedOutput {
        text: String::from_utf8_lossy(&retained).into_owned(),
        truncated,
        error,
    }
}

fn receive_output(receiver: mpsc::Receiver<CapturedOutput>, stream: &str) -> CapturedOutput {
    receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap_or_else(|_| CapturedOutput {
            text: String::new(),
            truncated: true,
            error: Some(format!("{stream} reader did not close after process exit")),
        })
}

fn append_read_error(text: String, error: Option<String>) -> String {
    match error {
        Some(error) if text.is_empty() => format!("Output read failed: {error}"),
        Some(error) => format!("{text}\nOutput read failed: {error}"),
        None => text,
    }
}

#[cfg(unix)]
fn kill_process_group(process_id: u32) {
    let process_group = -(process_id as libc::pid_t);
    let result = unsafe { libc::kill(process_group, libc::SIGKILL) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            eprintln!("[loop-verifier] Failed to kill process group {process_id}: {error}");
        }
    }
}

#[cfg(not(unix))]
fn kill_process_group(_process_id: u32) {}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn kill_process_tree(child: &mut std::process::Child) {
    let process_id = child.id();
    kill_process_group(process_id);
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
}

#[cfg(not(unix))]
fn kill_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

fn run_verifier_blocking(config: VerifierConfig) -> VerificationResult {
    let repaired_path = crate::shell_env::resolved_path(&crate::pty::default_shell());
    run_verifier_blocking_with_path(config, repaired_path)
}

fn run_verifier_blocking_with_path(
    config: VerifierConfig,
    repaired_path: Option<String>,
) -> VerificationResult {
    let started = Instant::now();
    let program_hash = hash_file(Path::new(&config.program));
    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = repaired_path {
        command.env("PATH", path);
    }
    if let Some(cwd) = &config.cwd {
        command.current_dir(cwd);
    }
    configure_process_group(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let cwd = config
                .cwd
                .as_deref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "<inherited>".to_string());
            return VerificationResult {
                status: VerificationStatus::SpawnError,
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                stdout: String::new(),
                stderr: format!(
                    "Failed to spawn verifier '{}' in '{}': {error}",
                    config.program, cwd
                ),
                truncated: false,
                program_hash,
            };
        }
    };

    let stdout = child.stdout.take().expect("piped verifier stdout");
    let stderr = child.stderr.take().expect("piped verifier stderr");
    let limit = config.output_limit_bytes;
    let (stdout_tx, stdout_rx) = mpsc::sync_channel(1);
    let (stderr_tx, stderr_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = stdout_tx.send(read_bounded(stdout, limit));
    });
    std::thread::spawn(move || {
        let _ = stderr_tx.send(read_bounded(stderr, limit));
    });

    let (status, terminal_status) = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                kill_process_group(child.id());
                break (Some(status), None);
            }
            Ok(None)
                if config
                    .cancelled
                    .as_ref()
                    .is_some_and(|cancelled| cancelled.load(Ordering::Acquire)) =>
            {
                kill_process_tree(&mut child);
                break (child.wait().ok(), Some(VerificationStatus::Cancelled));
            }
            Ok(None) if started.elapsed() < config.timeout => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                kill_process_tree(&mut child);
                break (child.wait().ok(), Some(VerificationStatus::TimedOut));
            }
            Err(error) => {
                kill_process_tree(&mut child);
                let _ = child.wait();
                let stdout = receive_output(stdout_rx, "stdout");
                let stderr = receive_output(stderr_rx, "stderr");
                return VerificationResult {
                    status: VerificationStatus::SpawnError,
                    exit_code: None,
                    duration_ms: started.elapsed().as_millis() as u64,
                    stdout: append_read_error(stdout.text, stdout.error),
                    stderr: format!(
                        "{}\nFailed to wait for verifier: {error}",
                        append_read_error(stderr.text, stderr.error)
                    )
                    .trim()
                    .to_string(),
                    truncated: stdout.truncated || stderr.truncated,
                    program_hash,
                };
            }
        }
    };

    let stdout = receive_output(stdout_rx, "stdout");
    let stderr = receive_output(stderr_rx, "stderr");
    let exit_code = status.as_ref().and_then(std::process::ExitStatus::code);
    let verification_status = terminal_status.unwrap_or_else(|| {
        if status
            .as_ref()
            .is_some_and(std::process::ExitStatus::success)
        {
            VerificationStatus::Passed
        } else {
            VerificationStatus::NonZero
        }
    });

    VerificationResult {
        status: verification_status,
        exit_code,
        duration_ms: started.elapsed().as_millis() as u64,
        stdout: append_read_error(stdout.text, stdout.error),
        stderr: append_read_error(stderr.text, stderr.error),
        truncated: stdout.truncated || stderr.truncated,
        program_hash,
    }
}

pub async fn run_verifier(config: VerifierConfig) -> VerificationResult {
    match tokio::task::spawn_blocking(move || run_verifier_blocking(config)).await {
        Ok(result) => result,
        Err(error) => VerificationResult {
            status: VerificationStatus::SpawnError,
            exit_code: None,
            duration_ms: 0,
            stdout: String::new(),
            stderr: format!("Verifier worker failed: {error}"),
            truncated: false,
            program_hash: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[cfg(unix)]
    #[tokio::test]
    async fn verifier_records_success_output_and_program_hash() {
        let result = run_verifier(VerifierConfig {
            program: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                "printf verified; printf warning >&2".to_string(),
            ],
            cwd: None,
            timeout: std::time::Duration::from_secs(5),
            output_limit_bytes: 1024,
            cancelled: None,
        })
        .await;

        assert_eq!(result.status, VerificationStatus::Passed);
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "verified");
        assert_eq!(result.stderr, "warning");
        assert!(result.program_hash.is_some());
        assert!(!result.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn verifier_uses_a_repaired_path_for_bare_commands() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "workstreams-loop-verifier-path-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create verifier path");
        let program = root.join("verifier-path-probe");
        std::fs::write(&program, "#!/bin/sh\nprintf repaired-path\n")
            .expect("write verifier probe");
        let mut permissions = std::fs::metadata(&program)
            .expect("probe metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&program, permissions).expect("make probe executable");

        let result = run_verifier_blocking_with_path(
            VerifierConfig {
                program: "verifier-path-probe".to_string(),
                args: Vec::new(),
                cwd: None,
                timeout: Duration::from_secs(5),
                output_limit_bytes: 1024,
                cancelled: None,
            },
            Some(root.to_string_lossy().into_owned()),
        );

        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(result.status, VerificationStatus::Passed);
        assert_eq!(result.stdout, "repaired-path");
    }

    #[test]
    fn verifier_spawn_errors_name_the_program_and_working_directory() {
        let cwd = std::env::temp_dir();
        let result = run_verifier_blocking_with_path(
            VerifierConfig {
                program: "workstreams-missing-verifier".to_string(),
                args: Vec::new(),
                cwd: Some(cwd.clone()),
                timeout: Duration::from_secs(1),
                output_limit_bytes: 1024,
                cancelled: None,
            },
            None,
        );

        assert_eq!(result.status, VerificationStatus::SpawnError);
        assert!(result.stderr.contains("workstreams-missing-verifier"));
        assert!(result.stderr.contains(&cwd.display().to_string()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verifier_distinguishes_nonzero_exit_from_timeout() {
        let nonzero = run_verifier(VerifierConfig {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "exit 9".to_string()],
            cwd: None,
            timeout: std::time::Duration::from_secs(5),
            output_limit_bytes: 1024,
            cancelled: None,
        })
        .await;
        let timeout = run_verifier(VerifierConfig {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "sleep 30".to_string()],
            cwd: None,
            timeout: std::time::Duration::from_millis(100),
            output_limit_bytes: 1024,
            cancelled: None,
        })
        .await;

        assert_eq!(nonzero.status, VerificationStatus::NonZero);
        assert_eq!(nonzero.exit_code, Some(9));
        assert_eq!(timeout.status, VerificationStatus::TimedOut);
        assert!(timeout.duration_ms < 5_000);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verifier_drains_but_caps_large_output() {
        let result = run_verifier(VerifierConfig {
            program: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                "i=0; while [ $i -lt 1000 ]; do printf 1234567890; i=$((i+1)); done".to_string(),
            ],
            cwd: None,
            timeout: std::time::Duration::from_secs(5),
            output_limit_bytes: 128,
            cancelled: None,
        })
        .await;

        assert_eq!(result.status, VerificationStatus::Passed);
        assert_eq!(result.stdout.len(), 128);
        assert!(result.truncated);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verifier_cancels_the_whole_process_group() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let run = tokio::spawn(run_verifier(VerifierConfig {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "sleep 30".to_string()],
            cwd: None,
            timeout: std::time::Duration::from_secs(20),
            output_limit_bytes: 1024,
            cancelled: Some(Arc::clone(&cancelled)),
        }));
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancelled.store(true, Ordering::Release);

        let result = run.await.expect("verifier task");

        assert_eq!(result.status, VerificationStatus::Cancelled);
        assert!(result.duration_ms < 5_000);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verifier_does_not_wait_for_a_lingering_grandchild_pipe() {
        let result = run_verifier(VerifierConfig {
            program: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                "sleep 30 & printf parent-done".to_string(),
            ],
            cwd: None,
            timeout: std::time::Duration::from_secs(5),
            output_limit_bytes: 1024,
            cancelled: None,
        })
        .await;

        assert_eq!(result.status, VerificationStatus::Passed);
        assert_eq!(result.stdout, "parent-done");
        assert!(result.duration_ms < 5_000);
    }

    #[test]
    fn bounded_reader_retries_interrupts_and_reports_other_errors() {
        struct InterruptThenData {
            interrupted: bool,
            data: io::Cursor<Vec<u8>>,
        }
        impl Read for InterruptThenData {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(io::Error::from(io::ErrorKind::Interrupted));
                }
                self.data.read(buffer)
            }
        }
        struct BrokenReader;
        impl Read for BrokenReader {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("broken pipe reader"))
            }
        }

        let recovered = read_bounded(
            InterruptThenData {
                interrupted: false,
                data: io::Cursor::new(b"complete".to_vec()),
            },
            64,
        );
        assert_eq!(recovered.text, "complete");
        assert!(!recovered.truncated);
        assert!(recovered.error.is_none());

        let failed = read_bounded(BrokenReader, 64);
        assert!(failed.truncated);
        assert_eq!(failed.error.as_deref(), Some("broken pipe reader"));
    }
}
