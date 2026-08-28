use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct VerifierConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    pub output_limit_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Passed,
    NonZero,
    TimedOut,
    SpawnError,
}

impl VerificationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::NonZero => "nonzero",
            Self::TimedOut => "timed_out",
            Self::SpawnError => "spawn_error",
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

fn read_bounded<R: Read>(mut reader: R, limit: usize) -> (String, bool) {
    let mut retained = Vec::with_capacity(limit.min(16 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8 * 1024];
    while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(retained.len());
        let keep = read.min(remaining);
        retained.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    (String::from_utf8_lossy(&retained).into_owned(), truncated)
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn kill_process_tree(child: &mut std::process::Child) {
    let process_group = -(child.id() as libc::pid_t);
    let killed = unsafe { libc::kill(process_group, libc::SIGKILL) };
    if killed != 0 {
        let _ = child.kill();
    }
}

#[cfg(not(unix))]
fn kill_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

fn run_verifier_blocking(config: VerifierConfig) -> VerificationResult {
    let started = Instant::now();
    let program_hash = hash_file(Path::new(&config.program));
    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &config.cwd {
        command.current_dir(cwd);
    }
    configure_process_group(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return VerificationResult {
                status: VerificationStatus::SpawnError,
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                stdout: String::new(),
                stderr: error.to_string(),
                truncated: false,
                program_hash,
            };
        }
    };

    let stdout = child.stdout.take().expect("piped verifier stdout");
    let stderr = child.stderr.take().expect("piped verifier stderr");
    let limit = config.output_limit_bytes;
    let stdout_reader = std::thread::spawn(move || read_bounded(stdout, limit));
    let stderr_reader = std::thread::spawn(move || read_bounded(stderr, limit));

    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), false),
            Ok(None) if started.elapsed() < config.timeout => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                kill_process_tree(&mut child);
                break (child.wait().ok(), true);
            }
            Err(error) => {
                kill_process_tree(&mut child);
                let _ = child.wait();
                let (stdout, stdout_truncated) = stdout_reader
                    .join()
                    .unwrap_or_else(|_| (String::new(), false));
                let (stderr, stderr_truncated) = stderr_reader
                    .join()
                    .unwrap_or_else(|_| (String::new(), false));
                return VerificationResult {
                    status: VerificationStatus::SpawnError,
                    exit_code: None,
                    duration_ms: started.elapsed().as_millis() as u64,
                    stdout,
                    stderr: format!("{stderr}\nFailed to wait for verifier: {error}")
                        .trim()
                        .to_string(),
                    truncated: stdout_truncated || stderr_truncated,
                    program_hash,
                };
            }
        }
    };

    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .unwrap_or_else(|_| (String::new(), false));
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .unwrap_or_else(|_| (String::new(), false));
    let exit_code = status.as_ref().and_then(std::process::ExitStatus::code);
    let verification_status = if timed_out {
        VerificationStatus::TimedOut
    } else if status
        .as_ref()
        .is_some_and(std::process::ExitStatus::success)
    {
        VerificationStatus::Passed
    } else {
        VerificationStatus::NonZero
    };

    VerificationResult {
        status: verification_status,
        exit_code,
        duration_ms: started.elapsed().as_millis() as u64,
        stdout,
        stderr,
        truncated: stdout_truncated || stderr_truncated,
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
    #[tokio::test]
    async fn verifier_distinguishes_nonzero_exit_from_timeout() {
        let nonzero = run_verifier(VerifierConfig {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "exit 9".to_string()],
            cwd: None,
            timeout: std::time::Duration::from_secs(5),
            output_limit_bytes: 1024,
        })
        .await;
        let timeout = run_verifier(VerifierConfig {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "sleep 30".to_string()],
            cwd: None,
            timeout: std::time::Duration::from_millis(100),
            output_limit_bytes: 1024,
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
        })
        .await;

        assert_eq!(result.status, VerificationStatus::Passed);
        assert_eq!(result.stdout.len(), 128);
        assert!(result.truncated);
    }
}
