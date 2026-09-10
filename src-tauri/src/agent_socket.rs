//! Local socket transport that lets an agent drive the running app.
//!
//! An agent inside a Copilot session tile reaches Workstreams through a CLI that
//! speaks to this socket. Writes go through the app rather than straight to
//! SQLite so the invariants that live in Rust — worktree creation, tile
//! provisioning, layout defaults — keep being enforced exactly once.
//!
//! See ADR 026 and `files/features/agent-driven-workstreams/spikes/socket/`.

pub use crate::agent_protocol::{
    decode_request, encode_request, encode_response, AgentError, AgentRequest, AgentResponse,
};
use std::io::{ErrorKind, Read};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

/// Largest path a Unix socket may bind to.
///
/// `sun_path` is a fixed-size field: 104 bytes on macOS, 108 on Linux. We use
/// the smaller so a path that binds on one platform binds on the other.
pub const SUN_PATH_MAX: usize = 104;

/// Environment variable naming the socket of the app that spawned this process.
///
/// Injected per session, so a session always reaches the instance that owns it
/// rather than whichever instance happens to hold a well-known path.
pub const SOCKET_ENV_VAR: &str = "WORKSTREAMS_SOCKET";

/// Builds the socket path for one app instance inside `dir`.
///
/// Separate from [`resolve_socket_path`] so tests can pin the directory.
pub fn socket_path_in(dir: &Path, instance: u32) -> PathBuf {
    dir.join(format!("workstreams-{instance}.sock"))
}

/// Chooses a socket path from an explicit override, a directory and an instance.
///
/// Pure, so the decision can be tested without mutating process-wide
/// environment state that parallel tests would race over.
pub fn choose_socket_path(override_value: Option<&str>, dir: &Path, instance: u32) -> PathBuf {
    match override_value {
        Some(configured) if !configured.trim().is_empty() => PathBuf::from(configured),
        _ => socket_path_in(dir, instance),
    }
}

/// Resolves the socket path for this app instance.
///
/// Deliberately **not** under the app data directory. A socket there measures 83
/// of the 104 available bytes on a 19-character username, leaving a budget of
/// only 33 characters once the per-instance suffix is added — so a corporate
/// account like `alejandro.echeverria@microsoft.com` would bind on the
/// developer's machine and fail on the user's.
///
/// The per-user temp directory has no such problem: on macOS it is a
/// fixed-length hash (`/var/folders/<hash>/T/`) independent of the username, and
/// it is already `0700`, so the socket is unreachable by other local accounts
/// before we narrow its own permissions. It is also cleared on reboot, which
/// disposes of sockets left behind by a crash.
///
/// `WORKSTREAMS_SOCKET` overrides everything, so a test or a second dev build
/// can pin its own path.
pub fn resolve_socket_path() -> PathBuf {
    choose_socket_path(
        std::env::var(SOCKET_ENV_VAR).ok().as_deref(),
        &std::env::temp_dir(),
        std::process::id(),
    )
}

/// Whether `path` is short enough to bind.
///
/// Callers should check before binding: the failure is otherwise a bare
/// `InvalidInput` from the OS with nothing pointing at the length.
pub fn fits_sun_path(path: &Path) -> bool {
    path.as_os_str().len() < SUN_PATH_MAX
}

/// Resolves the socket a *client* should talk to.
///
/// Unlike [`resolve_socket_path`], there is no fallback. The app derives its
/// path from its own pid; a client that did the same would probe a path nothing
/// has ever bound and then report the app as missing. The variable is injected
/// into every session Workstreams spawns, so its absence means something
/// specific and worth saying: this process is not running inside Workstreams.
pub fn client_socket_path(configured: Option<&str>) -> Result<PathBuf, AgentError> {
    match configured {
        Some(value) if !value.trim().is_empty() => Ok(PathBuf::from(value)),
        _ => Err(AgentError::new(
            "NOT_IN_WORKSTREAMS",
            format!("{SOCKET_ENV_VAR} is not set"),
            "This command only works inside a Copilot session spawned by Workstreams. Open the workstream in the Workstreams app and run it from a session tile there.",
        )),
    }
}

/// Sends one request to a running app and returns its answer.
///
/// Every failure is an [`AgentError`] with a hint, because this is the layer an
/// agent sees when something is wrong with the *channel* rather than with its
/// command — and the two need different reactions.
pub fn send_request(
    path: &Path,
    request: &AgentRequest,
    timeout: std::time::Duration,
) -> Result<AgentResponse, AgentError> {
    let mut stream = UnixStream::connect(path).map_err(|error| {
        // NotFound means the app never started; ConnectionRefused means it died
        // and left the path behind. The caller can do nothing different about
        // either, so they collapse to one cause.
        AgentError::new(
            "APP_NOT_RUNNING",
            format!("Could not reach Workstreams at {}: {error}", path.display()),
            "Start the Workstreams app and retry. The command itself may be fine.",
        )
    })?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    std::io::Write::write_all(&mut stream, encode_request(request).as_bytes()).map_err(
        |error| {
            AgentError::new(
                "SEND_FAILED",
                format!("Could not send the request: {error}"),
                "The app may have exited mid-request. Retry once.",
            )
        },
    )?;
    let _ = std::io::Write::flush(&mut stream);

    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(&stream), &mut line).map_err(
        |error| {
            let timed_out = matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut);
            if timed_out {
                AgentError::new(
                    "TIMEOUT",
                    format!("Workstreams did not answer within {timeout:?}"),
                    "The app may be busy. Retry, or check it is responsive.",
                )
            } else {
                AgentError::new(
                    "READ_FAILED",
                    format!("Could not read the reply: {error}"),
                    "The app may have exited mid-request. Retry once.",
                )
            }
        },
    )?;

    // `read_line` returns Ok(0) at EOF, so a connection closed before the reply
    // arrives looks like a successful empty read. Treating that as success hands
    // the agent an empty result to parse; it is a failure.
    if line.trim().is_empty() {
        return Err(AgentError::new(
            "NO_REPLY",
            "Workstreams closed the connection without answering",
            "The app likely exited mid-command. Check it is running and retry.",
        ));
    }

    serde_json::from_str(line.trim()).map_err(|error| {
        AgentError::new(
            "BAD_REPLY",
            format!("Could not parse the reply: {error}"),
            "This is a version mismatch or a bug; report it.",
        )
    })
}

/// Largest request the app will read.
///
/// Generous relative to any real command, and bounded so an unauthenticated
/// client cannot make the app allocate without limit.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// How long a connection may stall before it is dropped.
const CLIENT_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Connections served at once.
///
/// Thread-per-connection is right for the expected load, but unbounded thread
/// creation is not: `thread::spawn` panics when the OS refuses, and the release
/// profile aborts on panic, so an unauthenticated client could take the app
/// down with it.
const MAX_CONCURRENT_CONNECTIONS: usize = 32;

/// Holds one slot in the connection budget, releasing it on drop.
struct ConnectionPermit {
    in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl ConnectionPermit {
    fn acquire(in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>) -> Self {
        in_flight.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self { in_flight }
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.in_flight
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Owns the agent socket for the lifetime of the app.
///
/// Accepts on a background thread and answers each connection on its own
/// thread. The spike ran sixteen simultaneous clients without cross-talk, so a
/// thread per connection is sufficient and an async runtime would be weight
/// without benefit.
pub struct AgentSocketServer {
    path: PathBuf,
}

impl AgentSocketServer {
    /// Binds and begins accepting.
    ///
    /// `dispatch` runs on the connection's own thread, so it must be `Sync`.
    pub fn start<F>(path: PathBuf, dispatch: F) -> Result<Self, String>
    where
        F: Fn(AgentRequest) -> AgentResponse + Send + Sync + 'static,
    {
        let listener = bind_agent_socket(&path)?;
        let dispatch = std::sync::Arc::new(dispatch);
        let in_flight = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    // A single failed accept is not fatal: the listener is still
                    // bound, and giving up here would silently disable the agent
                    // channel for the rest of the session.
                    continue;
                };
                if in_flight.load(std::sync::atomic::Ordering::SeqCst) >= MAX_CONCURRENT_CONNECTIONS
                {
                    // Refuse politely rather than queueing without limit, so a
                    // client learns why instead of hanging.
                    let mut stream = stream;
                    let response = AgentResponse::failed(AgentError::new(
                        "APP_BUSY",
                        "Too many agent connections are already in flight",
                        "Retry in a moment.",
                    ));
                    let _ = std::io::Write::write_all(
                        &mut stream,
                        encode_response(&response).as_bytes(),
                    );
                    continue;
                }

                let dispatch = std::sync::Arc::clone(&dispatch);
                // An RAII permit rather than a manual decrement: a dispatch
                // panic unwinds past any trailing statement, so a hand-written
                // decrement would silently consume a slot each time and, after
                // enough panics, refuse every connection as APP_BUSY. Drop runs
                // on unwind, on early return, and when a failed spawn returns
                // the closure to us.
                let permit = ConnectionPermit::acquire(std::sync::Arc::clone(&in_flight));
                let spawned = std::thread::Builder::new()
                    .name("agent-conn".to_string())
                    .spawn(move || {
                        let _permit = permit;
                        handle_connection(stream, |request| dispatch(request));
                    });
                if spawned.is_err() {
                    // The permit moved into the closure, which was never run;
                    // spawn gives it back inside the error, and dropping that
                    // releases the slot.
                    eprintln!("[agent] Could not start a connection thread; dropping it");
                }
            }
        });
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for AgentSocketServer {
    fn drop(&mut self) {
        // Leaving the file behind is survivable — the next launch reclaims it —
        // but cleaning up keeps a normal shutdown from looking like a crash.
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Reads one request from `stream`, dispatches it, and writes one response.
///
/// Errors are answered rather than dropped: a closed connection reaches the
/// agent as an empty reply, which looks like the app dying and sends it down a
/// diagnostic path that has nothing to do with the malformed request it sent.
pub fn handle_connection<F>(mut stream: UnixStream, dispatch: F)
where
    F: FnOnce(AgentRequest) -> AgentResponse,
{
    // A client that connects and says nothing would otherwise hold its thread
    // and descriptor until the app exits, and one that never sends a newline
    // would grow the buffer without limit. Neither needs to authenticate first,
    // so both bounds apply before any identity is known.
    let _ = stream.set_read_timeout(Some(CLIENT_IDLE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CLIENT_IDLE_TIMEOUT));

    let Ok(peer) = stream.try_clone() else {
        return;
    };
    let mut line = Vec::new();
    let mut reader = std::io::BufReader::new(peer).take(MAX_FRAME_BYTES as u64 + 1);
    if std::io::BufRead::read_until(&mut reader, b'\n', &mut line).is_err() {
        return;
    }
    if line.len() > MAX_FRAME_BYTES {
        let response = AgentResponse::failed(AgentError::new(
            "REQUEST_TOO_LARGE",
            format!("Requests are limited to {MAX_FRAME_BYTES} bytes"),
            "Send less data, or reference a file by path instead of inlining it.",
        ));
        let _ = std::io::Write::write_all(&mut stream, encode_response(&response).as_bytes());
        return;
    }
    let line = String::from_utf8_lossy(&line).into_owned();

    let response = match decode_request(&line) {
        Ok(request) => dispatch(request),
        Err(error) => AgentResponse::failed(error),
    };
    let _ = std::io::Write::write_all(&mut stream, encode_response(&response).as_bytes());
    let _ = std::io::Write::flush(&mut stream);
}

/// Binds the agent socket, reclaiming one left behind by a crash.
///
/// Two things here are easy to get wrong and expensive to get wrong:
///
/// 1. **A fresh socket is world-connectable.** The default mode is `0755`, so on
///    a shared machine any other local account could drive the app. The
///    narrowing happens here rather than in a separate initialisation step,
///    because a step like that can be skipped or reordered.
/// 2. **A leftover path is ambiguous.** It is either a corpse from a `SIGKILL`
///    or a *live sibling instance*. Connecting is the only way to tell them
///    apart, so we connect first and unlink only when that fails. An
///    unconditional unlink would silently evict a running app.
pub fn bind_agent_socket(path: &Path) -> Result<UnixListener, String> {
    if !fits_sun_path(path) {
        return Err(format!(
            "Socket path is too long ({} bytes, limit {SUN_PATH_MAX}): {}",
            path.as_os_str().len(),
            path.display()
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create socket directory: {error}"))?;
    }

    let listener = match UnixListener::bind(path) {
        Ok(listener) => listener,
        Err(error) if error.kind() == ErrorKind::AddrInUse => {
            if UnixStream::connect(path).is_ok() {
                return Err(format!(
                    "another instance is already serving {}",
                    path.display()
                ));
            }
            // A failed connect is not a licence to delete whatever is there. If
            // the path is a regular file -- a misconfigured override, or a name
            // collision -- unlinking it would destroy someone's data to make
            // room for a socket.
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
            if !metadata.file_type().is_socket() {
                return Err(format!(
                    "{} exists and is not a socket; refusing to remove it",
                    path.display()
                ));
            }
            std::fs::remove_file(path)
                .map_err(|error| format!("Failed to clear a stale socket: {error}"))?;
            UnixListener::bind(path)
                .map_err(|error| format!("Failed to bind the agent socket: {error}"))?
        }
        Err(error) => return Err(format!("Failed to bind the agent socket: {error}")),
    };

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to restrict socket permissions: {error}"))?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    /// Stands in for the app's real dispatcher, which needs a database and an
    /// identity registry this layer knows nothing about.
    fn test_dispatch(request: AgentRequest) -> AgentResponse {
        AgentResponse::ok(serde_json::json!({ "saw": request.cmd }))
    }

    /// Short on purpose: the 104-byte budget applies to test paths too, and a
    /// descriptive directory name is enough to exhaust it under `$TMPDIR`.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wsa-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    /// A socket is world-connectable when freshly bound, so the narrowing must
    /// happen in the same call — not in a separate step a caller could skip.
    #[test]
    fn binding_narrows_permissions_to_the_owner() {
        let dir = scratch_dir("perms");
        let path = socket_path_in(&dir, 1);
        let listener = bind_agent_socket(&path).expect("bind");
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        drop(listener);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(mode, 0o600, "expected owner-only, got {mode:o}");
    }

    /// A crash leaves the socket file behind. Re-binding must reclaim it rather
    /// than refusing to start for the rest of the machine's uptime.
    #[test]
    fn a_socket_left_by_a_crash_is_reclaimed() {
        let dir = scratch_dir("stale");
        let path = socket_path_in(&dir, 2);
        drop(bind_agent_socket(&path).expect("first bind"));
        assert!(path.exists(), "a killed process leaves the path on disk");

        let reclaimed = bind_agent_socket(&path);
        let ok = reclaimed.is_ok();
        drop(reclaimed);
        std::fs::remove_dir_all(&dir).ok();
        assert!(ok, "expected the stale socket to be reclaimed");
    }

    /// The dangerous case: an unconditional unlink would evict a sibling app
    /// instance that is alive and serving. Only a failed connect proves death.
    #[test]
    fn a_live_socket_is_not_stolen_from_a_sibling_instance() {
        let dir = scratch_dir("live");
        let path = socket_path_in(&dir, 3);
        let live = bind_agent_socket(&path).expect("first instance binds");
        let second = bind_agent_socket(&path);
        let error = second.err().map(|error| error.to_string());
        drop(live);
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            error.is_some_and(|message| message.contains("another instance")),
            "a live socket must not be stolen"
        );
    }

    /// Exercises bind, frame, dispatch and reply over a real socket rather than
    /// in-memory strings, because the framing bug this guards against only
    /// appears once a stream is involved.
    #[test]
    fn a_connection_round_trips_through_the_dispatcher() {
        let dir = scratch_dir("serve");
        let path = socket_path_in(&dir, 5);
        let listener = bind_agent_socket(&path).expect("bind");
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            handle_connection(stream, |request| {
                AgentResponse::ok(serde_json::json!({ "saw": request.cmd }))
            });
        });

        let mut client = UnixStream::connect(&path).expect("connect");
        client
            .write_all(
                encode_request(&AgentRequest {
                    cmd: "ws.create".to_string(),
                    params: serde_json::Value::Null,
                    token: None,
                })
                .as_bytes(),
            )
            .expect("write");
        let mut reply = String::new();
        std::io::BufReader::new(&client)
            .read_line(&mut reply)
            .expect("read");
        server.join().expect("server thread");
        std::fs::remove_dir_all(&dir).ok();

        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).expect("parse");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["saw"], "ws.create");
    }

    /// Garbage on the wire must still be answered. Closing the connection would
    /// surface to the agent as the app having died, which is a different bug
    /// with a different fix.
    #[test]
    fn a_garbage_frame_is_answered_rather_than_dropped() {
        let dir = scratch_dir("garbage");
        let path = socket_path_in(&dir, 6);
        let listener = bind_agent_socket(&path).expect("bind");
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            handle_connection(stream, |_| {
                panic!("the dispatcher must not be reached for an unparseable frame")
            });
        });

        let mut client = UnixStream::connect(&path).expect("connect");
        client.write_all(b"{not json\n").expect("write");
        let mut reply = String::new();
        std::io::BufReader::new(&client)
            .read_line(&mut reply)
            .expect("read");
        server.join().expect("server thread");
        std::fs::remove_dir_all(&dir).ok();

        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).expect("parse");
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["code"], "BAD_REQUEST");
    }

    /// The server owns the socket for the app's lifetime: it must serve
    /// repeatedly, and it must clean the path up when it goes away so the next
    /// launch does not have to reclaim a corpse.
    #[test]
    fn the_server_serves_many_connections_and_cleans_up_after_itself() {
        let dir = scratch_dir("server");
        let path = socket_path_in(&dir, 7);
        let server = AgentSocketServer::start(path.clone(), |request| {
            AgentResponse::ok(serde_json::json!({ "saw": request.cmd }))
        })
        .expect("start server");
        assert_eq!(server.path(), path.as_path());

        for index in 0..3 {
            let mut client = UnixStream::connect(&path).expect("connect");
            client
                .write_all(
                    encode_request(&AgentRequest {
                        cmd: format!("ws.create.{index}"),
                        params: serde_json::Value::Null,
                        token: None,
                    })
                    .as_bytes(),
                )
                .expect("write");
            let mut reply = String::new();
            std::io::BufReader::new(&client)
                .read_line(&mut reply)
                .expect("read");
            let parsed: serde_json::Value = serde_json::from_str(reply.trim()).expect("parse");
            assert_eq!(parsed["data"]["saw"], format!("ws.create.{index}"));
        }

        drop(server);
        let gone = !path.exists();
        std::fs::remove_dir_all(&dir).ok();
        assert!(gone, "the server must unlink its socket on shutdown");
    }

    // ── Client ─────────────────────────────────────────────────────────────

    /// The client must never invent a socket path. `resolve_socket_path` derives
    /// one from the current pid, which is correct for the app that is about to
    /// bind and meaningless for a client, which would then probe a path that has
    /// never existed and report the app as "not running".
    #[test]
    fn a_client_outside_workstreams_is_told_so_rather_than_guessing_a_path() {
        let error = client_socket_path(None).expect_err("no session means no socket");
        assert_eq!(error.code, "NOT_IN_WORKSTREAMS");
        assert!(
            error.hint.contains("Workstreams"),
            "the agent must learn where it is supposed to run: {}",
            error.hint
        );

        let path = client_socket_path(Some("/tmp/ws-from-env.sock")).expect("env wins");
        assert_eq!(path, PathBuf::from("/tmp/ws-from-env.sock"));
    }

    #[test]
    fn a_blank_socket_variable_is_treated_as_absent() {
        assert!(client_socket_path(Some("   ")).is_err());
    }

    #[test]
    fn the_client_round_trips_against_a_running_server() {
        let dir = scratch_dir("client");
        let path = socket_path_in(&dir, 8);
        let server = AgentSocketServer::start(path.clone(), test_dispatch).expect("start");
        let response = send_request(
            &path,
            &AgentRequest {
                cmd: "agent.ping".to_string(),
                params: serde_json::Value::Null,
                token: None,
            },
            Duration::from_secs(5),
        )
        .expect("round trip");
        drop(server);
        std::fs::remove_dir_all(&dir).ok();
        assert!(response.ok);
    }

    /// Both "never started" (`NotFound`) and "crashed, file left behind"
    /// (`ConnectionRefused`) mean the same thing to the caller, and both must
    /// say so — otherwise an agent reads a connection failure as a bad argument
    /// and starts rewriting a command that was correct.
    #[test]
    fn every_way_the_app_can_be_absent_reports_app_not_running() {
        let dir = scratch_dir("absent");

        let never_started = socket_path_in(&dir, 9);
        let error = send_request(
            &never_started,
            &AgentRequest {
                cmd: "agent.ping".to_string(),
                params: serde_json::Value::Null,
                token: None,
            },
            Duration::from_secs(1),
        )
        .expect_err("nothing is listening");
        assert_eq!(error.code, "APP_NOT_RUNNING");

        // A crash leaves the file present but unconnectable.
        let crashed = socket_path_in(&dir, 10);
        drop(bind_agent_socket(&crashed).expect("bind"));
        let error = send_request(
            &crashed,
            &AgentRequest {
                cmd: "agent.ping".to_string(),
                params: serde_json::Value::Null,
                token: None,
            },
            Duration::from_secs(1),
        )
        .expect_err("the owner is gone");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(error.code, "APP_NOT_RUNNING");
        assert!(!error.hint.is_empty());
    }

    /// The subtle one. When the app accepts and then dies before replying,
    /// `read_line` returns `Ok(0)` — EOF looks exactly like success, so a naive
    /// client hands the agent an empty result to parse.
    #[test]
    fn an_empty_reply_is_a_failure_rather_than_an_empty_success() {
        let dir = scratch_dir("noreply");
        let path = socket_path_in(&dir, 11);
        let listener = bind_agent_socket(&path).expect("bind");
        let server = std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                // Consume the request first, so the client's write succeeds and
                // the failure lands on the *read* — dying earlier than this
                // breaks the pipe instead and surfaces as SEND_FAILED.
                let mut line = String::new();
                let _ =
                    std::io::BufRead::read_line(&mut std::io::BufReader::new(&stream), &mut line);
                drop(stream); // die before answering
            }
        });

        let error = send_request(
            &path,
            &AgentRequest {
                cmd: "agent.ping".to_string(),
                params: serde_json::Value::Null,
                token: None,
            },
            Duration::from_secs(2),
        )
        .expect_err("an empty reply must not read as success");
        server.join().expect("server");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(error.code, "NO_REPLY");
    }

    /// A hung app must not hang the agent with it.
    #[test]
    fn a_hung_app_trips_the_read_timeout() {
        let dir = scratch_dir("hung");
        let path = socket_path_in(&dir, 12);
        let listener = bind_agent_socket(&path).expect("bind");
        let server = std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                std::thread::sleep(Duration::from_millis(1500));
                drop(stream);
            }
        });

        let started = std::time::Instant::now();
        let error = send_request(
            &path,
            &AgentRequest {
                cmd: "agent.ping".to_string(),
                params: serde_json::Value::Null,
                token: None,
            },
            Duration::from_millis(200),
        )
        .expect_err("should time out");
        let elapsed = started.elapsed();
        server.join().expect("server");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(error.code, "TIMEOUT");
        assert!(elapsed < Duration::from_secs(1), "took {elapsed:?}");
    }

    /// An unauthenticated client must not be able to make the app allocate
    /// without limit, so the cap applies before any identity is known.
    #[test]
    fn an_oversized_request_is_refused_rather_than_buffered() {
        let dir = scratch_dir("toobig");
        let path = socket_path_in(&dir, 13);
        let listener = bind_agent_socket(&path).expect("bind");
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            handle_connection(stream, |_| {
                panic!("an oversized frame must never reach the dispatcher")
            });
        });

        let mut client = UnixStream::connect(&path).expect("connect");
        // No newline anywhere: the naive reader would grow until memory ran out.
        client
            .write_all(&vec![b'x'; MAX_FRAME_BYTES + 1024])
            .or_else(|error| {
                // The server may close mid-write once the cap trips, which is
                // the behaviour we want rather than a failure.
                if error.kind() == ErrorKind::BrokenPipe {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .expect("write");
        let mut reply = String::new();
        let _ = std::io::BufReader::new(&client).read_line(&mut reply);
        server.join().expect("server thread");
        std::fs::remove_dir_all(&dir).ok();

        // The reply must actually arrive: asserting only "the dispatcher was
        // not reached" would pass if the server silently dropped the client,
        // which is a different and worse behaviour.
        let parsed: serde_json::Value = serde_json::from_str(reply.trim())
            .unwrap_or_else(|error| panic!("expected a refusal, got {reply:?}: {error}"));
        assert_eq!(parsed["code"], "REQUEST_TOO_LARGE");
    }

    /// A failed connect is not a licence to delete whatever is at the path.
    #[test]
    fn a_regular_file_at_the_socket_path_is_not_destroyed() {
        let dir = scratch_dir("notsock");
        let path = socket_path_in(&dir, 14);
        std::fs::write(&path, b"someone's data").expect("write file");

        let error = bind_agent_socket(&path)
            .err()
            .unwrap_or_else(|| "unexpectedly bound over a regular file".to_string());
        let survived = std::fs::read(&path).ok();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            survived.as_deref(),
            Some(&b"someone's data"[..]),
            "the file must not be deleted to make room for a socket"
        );
        assert!(error.contains("not a socket"), "unexpected error: {error}");
    }

    /// A handler that panics must not consume its slot permanently, or enough
    /// panics leave the app refusing every connection.
    #[test]
    fn a_panicking_handler_releases_its_connection_slot() {
        let in_flight = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let permit = ConnectionPermit::acquire(std::sync::Arc::clone(&in_flight));
        assert_eq!(in_flight.load(std::sync::atomic::Ordering::SeqCst), 1);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _permit = permit;
            panic!("dispatch blew up");
        }));
        assert!(result.is_err(), "the panic should have propagated");
        assert_eq!(
            in_flight.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "unwinding past a manual decrement is exactly the leak this guards"
        );
    }

    #[test]
    fn binding_refuses_a_path_that_cannot_fit() {
        let dir = std::env::temp_dir().join("x".repeat(120));
        let error = bind_agent_socket(&socket_path_in(&dir, 4))
            .err()
            .map(|error| error.to_string())
            .unwrap_or_default();
        assert!(
            error.contains("too long"),
            "expected a length diagnosis, got: {error}"
        );
    }

    /// The regression this whole design exists to prevent: a path that fits on
    /// the author's machine and overflows on someone else's.
    #[test]
    fn the_socket_path_fits_even_for_a_long_username() {
        let path = resolve_socket_path();
        assert!(
            fits_sun_path(&path),
            "{} is {} bytes, limit is {SUN_PATH_MAX}",
            path.display(),
            path.as_os_str().len()
        );

        // The temp directory is username-independent, so the only way to prove
        // the property is to show the app-data shape would have failed where
        // this one does not.
        let long_user = "a".repeat(40);
        let app_data = PathBuf::from(format!(
            "/Users/{long_user}/Library/Application Support/workstreams"
        ));
        assert!(
            !fits_sun_path(&socket_path_in(&app_data, 12345)),
            "the app-data path was expected to overflow for a 40-char username"
        );
        assert!(fits_sun_path(&socket_path_in(&std::env::temp_dir(), 12345)));
    }

    #[test]
    fn two_instances_get_two_paths() {
        let dir = std::env::temp_dir();
        assert_ne!(socket_path_in(&dir, 1), socket_path_in(&dir, 2));
    }

    #[test]
    fn an_override_wins_over_the_derived_path() {
        let path = choose_socket_path(Some("/tmp/ws-override-test.sock"), &std::env::temp_dir(), 1);
        assert_eq!(path, PathBuf::from("/tmp/ws-override-test.sock"));
    }

    #[test]
    fn a_blank_override_falls_back_instead_of_binding_nothing() {
        let dir = std::env::temp_dir();
        for blank in [None, Some(""), Some("   ")] {
            let path = choose_socket_path(blank, &dir, 7);
            assert_eq!(path, socket_path_in(&dir, 7), "blank = {blank:?}");
            assert!(fits_sun_path(&path));
        }
    }

    /// Guards the spike's central finding against a well-meaning future change
    /// that "tidies" the socket next to the database.
    #[test]
    fn the_socket_does_not_live_beside_the_database() {
        let socket = choose_socket_path(None, &std::env::temp_dir(), std::process::id());
        let database = crate::db::resolve_db_path();
        assert_ne!(
            socket.parent(),
            database.parent(),
            "the socket must stay in the temp directory, not follow the database"
        );
    }
}
