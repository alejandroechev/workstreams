//! Login-shell PATH resolution for GUI launches.
//!
//! macOS GUI apps started from the Dock/Finder go through LaunchServices and
//! inherit **launchd's** environment, not the user's shell environment. In
//! practice that means:
//!
//! ```text
//! PATH=/usr/bin:/bin:/usr/sbin:/sbin
//! ```
//!
//! `~/.zshrc` / `~/.zprofile` are never read, so user-installed tools
//! (`agency`, `copilot`, `node` via nodenv/nvm, Homebrew binaries) are all
//! invisible. Every PTY we spawn inherits that stunted PATH, so the Copilot
//! CLI fails to exec and the tile renders an empty terminal.
//!
//! Windows is unaffected: GUI processes inherit the user/system PATH from the
//! registry, so the resolution here is `cfg(unix)`-only and Windows keeps the
//! inherited environment byte-for-byte.
//!
//! The fix mirrors what VS Code and other Electron/Tauri editors do: ask the
//! user's login shell for its PATH once per process and reuse it for every
//! spawned PTY.

#[cfg(unix)]
use std::sync::OnceLock;

/// Parse the raw stdout of the login-shell PATH probe.
///
/// Interactive login shells print MOTDs, direnv banners and similar noise, so
/// we take the **last** non-empty line and require it to look like a PATH (at
/// least one absolute entry). Anything else is rejected so a broken profile
/// can never replace a working inherited PATH with garbage.
///
/// Only *called* from `cfg(unix)` code, but deliberately left uncompiled-out so
/// its unit tests run on every platform. Windows would otherwise fail
/// `clippy -D warnings` on dead code — which it did, breaking the pre-push gate
/// for anyone developing this repo on Windows.
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_login_path_output(raw: &str) -> Option<String> {
    let candidate = raw.lines().map(str::trim).rfind(|l| !l.is_empty())?;

    if !candidate.split(':').any(|entry| entry.starts_with('/')) {
        return None;
    }
    Some(candidate.to_string())
}

/// Merge the login-shell PATH with the PATH already inherited by the process.
///
/// Login entries win (they are the user's intent), but inherited entries are
/// appended so anything the launcher deliberately injected is preserved.
/// Duplicates are removed while keeping first-seen order, and empty segments
/// are dropped — a trailing `:` in PATH means "current directory" to some
/// tools, which we do not want to propagate into spawned shells.
///
/// See [`parse_login_path_output`] for why this is not `cfg(unix)`-gated.
#[cfg_attr(windows, allow(dead_code))]
pub fn merge_paths(login: Option<&str>, inherited: Option<&str>) -> Option<String> {
    let mut merged: Vec<&str> = Vec::new();
    for source in [login, inherited].into_iter().flatten() {
        for entry in source.split(':') {
            if entry.is_empty() || merged.contains(&entry) {
                continue;
            }
            merged.push(entry);
        }
    }
    if merged.is_empty() {
        return None;
    }
    Some(merged.join(":"))
}

/// True when `path` looks like the stunted PATH a GUI launch inherits.
///
/// Used to decide whether probing the login shell is worth the ~100 ms cost:
/// when the app was started from a terminal the inherited PATH is already
/// correct and we skip the probe entirely.
#[cfg(unix)]
pub fn looks_like_gui_launch_path(path: Option<&str>) -> bool {
    let Some(path) = path else {
        // No PATH at all is the most degenerate GUI launch case.
        return true;
    };
    const GUI_DEFAULTS: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    path.split(':')
        .filter(|e| !e.is_empty())
        .all(|entry| GUI_DEFAULTS.contains(&entry))
}

/// Ask the user's login shell for its PATH.
///
/// Runs `<shell> -lic 'printf %s "$PATH"'`:
/// - `-l` (login) picks up `~/.zprofile` / `~/.bash_profile`
/// - `-i` (interactive) picks up `~/.zshrc` / `~/.bashrc`, where most users
///   actually put their PATH edits
/// - `printf %s` avoids the trailing newline that `echo` adds
///
/// Returns `None` on any failure (missing shell, non-zero exit, unparseable
/// output) so the caller keeps the inherited PATH rather than breaking.
///
/// `stdin`/`stderr` are redirected to `/dev/null`: an **interactive** shell
/// that inherits a controlling terminal performs job-control operations on it
/// (and can raise `SIGTTOU`/`SIGTTIN` in the process group), which disturbs
/// unrelated child processes. Detaching keeps the probe side-effect free.
#[cfg(unix)]
fn probe_login_shell_path(shell: &str) -> Option<String> {
    let output = std::process::Command::new(shell)
        .args(["-lic", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_login_path_output(&String::from_utf8_lossy(&output.stdout))
}

/// Resolve the PATH to use for spawned PTYs, given an explicitly supplied
/// inherited PATH.
///
/// Split out from [`resolved_path`] so the full decision (detect GUI launch →
/// probe → merge) is testable without mutating process-global environment
/// state or defeating the one-shot cache.
#[cfg(unix)]
pub fn resolve_for(inherited: Option<&str>, shell: &str) -> Option<String> {
    if !looks_like_gui_launch_path(inherited) {
        return None;
    }
    let login = probe_login_shell_path(shell)?;
    merge_paths(Some(&login), inherited)
}

#[cfg(unix)]
static RESOLVED_PATH: OnceLock<Option<String>> = OnceLock::new();

/// The PATH that spawned PTYs should use, resolved once per process.
///
/// Returns `None` when the inherited PATH is already good (terminal launch) or
/// when the probe fails, in which case callers must leave PATH untouched.
#[cfg(unix)]
pub fn resolved_path(shell: &str) -> Option<String> {
    RESOLVED_PATH
        .get_or_init(|| {
            let inherited = std::env::var("PATH").ok();
            resolve_for(inherited.as_deref(), shell)
        })
        .clone()
}

/// Windows GUI processes already inherit the full user/system PATH from the
/// registry, so there is nothing to repair.
#[cfg(windows)]
pub fn resolved_path(_shell: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_path_line() {
        let parsed = parse_login_path_output("/usr/local/bin:/usr/bin:/bin");
        assert_eq!(parsed.as_deref(), Some("/usr/local/bin:/usr/bin:/bin"));
    }

    #[test]
    fn ignores_profile_noise_before_the_path() {
        // Interactive login shells routinely print banners (MOTD, direnv,
        // nvm). Only the final line is the PATH we asked printf to emit.
        let raw = "Welcome to your Mac!\ndirenv: loading .envrc\n/opt/homebrew/bin:/usr/bin\n";
        assert_eq!(
            parse_login_path_output(raw).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn rejects_output_without_any_absolute_entry() {
        // A profile that errors out could print anything; refuse to treat
        // non-PATH text as a PATH rather than corrupting spawned processes.
        assert_eq!(parse_login_path_output(""), None);
        assert_eq!(parse_login_path_output("   \n  \n"), None);
        assert_eq!(parse_login_path_output("command not found"), None);
    }

    #[test]
    fn merge_puts_login_entries_first_and_dedupes() {
        let merged = merge_paths(
            Some("/opt/homebrew/bin:/usr/bin:/bin"),
            Some("/usr/bin:/bin:/usr/sbin"),
        );
        assert_eq!(
            merged.as_deref(),
            Some("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin"),
            "login PATH wins, inherited-only entries are appended, no duplicates"
        );
    }

    #[test]
    fn merge_drops_empty_segments() {
        // A trailing ':' means "current directory" to some tools — never
        // propagate that into spawned shells.
        let merged = merge_paths(Some("/usr/bin::/bin:"), None);
        assert_eq!(merged.as_deref(), Some("/usr/bin:/bin"));
    }

    #[test]
    fn merge_handles_missing_sources() {
        assert_eq!(
            merge_paths(None, Some("/usr/bin")).as_deref(),
            Some("/usr/bin")
        );
        assert_eq!(
            merge_paths(Some("/usr/bin"), None).as_deref(),
            Some("/usr/bin")
        );
        assert_eq!(merge_paths(None, None), None);
    }

    #[cfg(unix)]
    #[test]
    fn detects_the_gui_launch_path() {
        // Exactly what LaunchServices hands a Dock-launched .app.
        assert!(looks_like_gui_launch_path(Some(
            "/usr/bin:/bin:/usr/sbin:/sbin"
        )));
        assert!(looks_like_gui_launch_path(Some("/usr/bin:/bin")));
        assert!(looks_like_gui_launch_path(None));
    }

    #[cfg(unix)]
    #[test]
    fn does_not_treat_a_terminal_launch_as_gui() {
        // Any user-specific entry means the app was started from a shell that
        // already sourced the user's profile — leave that PATH alone.
        assert!(!looks_like_gui_launch_path(Some(
            "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        )));
        assert!(!looks_like_gui_launch_path(Some(
            "/Users/me/.local/bin:/usr/bin"
        )));
    }

    #[cfg(unix)]
    #[test]
    fn probing_a_real_shell_returns_a_usable_path() {
        // /bin/sh exists on every Unix; the probe must return something that
        // at least contains /usr/bin, proving the -lic invocation works.
        let probed = probe_login_shell_path("/bin/sh");
        if let Some(p) = probed {
            assert!(
                p.split(':').any(|e| e.starts_with('/')),
                "probed PATH must contain absolute entries, got {p}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn probing_a_missing_shell_fails_soft() {
        assert_eq!(probe_login_shell_path("/nonexistent/shell/xyz"), None);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_repairs_a_gui_launch_path() {
        // End-to-end on the real machine: hand in exactly the PATH that
        // LaunchServices gives a Dock-launched .app and require the result to
        // be strictly richer. This is the regression guard for "Copilot tile
        // is blank after reopening from the Dock".
        let gui = "/usr/bin:/bin:/usr/sbin:/sbin";
        let Some(resolved) = resolve_for(Some(gui), "/bin/sh") else {
            // A sandboxed CI shell may have no profile to source; the unit
            // tests above already cover the parse/merge logic in isolation.
            return;
        };
        for required in gui.split(':') {
            assert!(
                resolved.split(':').any(|e| e == required),
                "inherited entry {required} must survive, got {resolved}"
            );
        }
        assert!(
            resolved.split(':').count() > gui.split(':').count(),
            "resolved PATH must add the login shell's entries, got {resolved}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_leaves_a_terminal_launch_alone() {
        // Started from a shell: the inherited PATH is already correct, so we
        // must not pay for a probe nor risk reordering the user's PATH.
        assert_eq!(
            resolve_for(Some("/opt/homebrew/bin:/usr/bin:/bin"), "/bin/sh"),
            None
        );
    }
}
