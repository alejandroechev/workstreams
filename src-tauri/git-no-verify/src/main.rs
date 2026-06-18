use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

mod filter;

const BYPASS_ENV: &str = "GIT_NOVERIFY_BYPASS";
const DEPTH_ENV: &str = "GIT_NOVERIFY_SHIM_DEPTH";

/// Debug-only override for tests. Release builds ignore this completely.
#[cfg(debug_assertions)]
const TEST_OVERRIDE_ENV: &str = "GIT_NOVERIFY_REAL_GIT";

fn main() -> ExitCode {
    let argv: Vec<String> = env::args().skip(1).collect();
    let bypass = env::var(BYPASS_ENV).map(|v| v == "1").unwrap_or(false);

    // Recursion guard: if we are already running inside a shim-spawned process
    // then something has gone wrong with PATH scrubbing and we are about to
    // spawn ourselves. Refuse loudly rather than fork-bomb the machine.
    if env::var(DEPTH_ENV).map(|v| v == "1").unwrap_or(false) {
        eprintln!(
            "git-no-verify: refusing to recurse — {DEPTH_ENV} is already set. \
             PATH scrubbing failed. Check shim install."
        );
        return ExitCode::from(2);
    }

    if filter::should_block(&argv, bypass) {
        eprintln!("{}", filter::BLOCK_MESSAGE);
        println!("{}", filter::BLOCK_MESSAGE);
        return ExitCode::from(1);
    }

    let (real_git, scrubbed_path) = match resolve_real_git() {
        Ok(x) => x,
        Err(e) => {
            eprintln!(
                "git-no-verify: cannot locate real git after removing shim dir from PATH: {e}\n\
                 Hint: ensure Git for Windows install dir (e.g. C:\\Program Files\\Git\\cmd) \
                 is on PATH outside the shim dir."
            );
            return ExitCode::from(127);
        }
    };

    let mut cmd = Command::new(&real_git);
    cmd.args(&argv);
    cmd.env(DEPTH_ENV, "1");
    if let Some(p) = scrubbed_path {
        cmd.env("PATH", p);
    }

    match cmd.status() {
        Ok(s) => ExitCode::from(s.code().unwrap_or(1) as u8),
        Err(e) => {
            eprintln!("git-no-verify: failed to spawn {}: {e}", real_git.display());
            ExitCode::from(127)
        }
    }
}

/// Returns (path-to-real-git, new-PATH-to-set-on-child-or-None-if-no-change).
///
/// Strategy:
/// 1. In debug builds, honor `GIT_NOVERIFY_REAL_GIT` test override; in that
///    case PATH is left untouched.
/// 2. Otherwise, determine our own directory from `current_exe`.
/// 3. Remove every PATH entry that resolves (case-insensitively, after
///    normalization) to our directory.
/// 4. Search the scrubbed PATH for `git.exe`.
fn resolve_real_git() -> Result<(PathBuf, Option<OsString>), String> {
    #[cfg(debug_assertions)]
    {
        if let Ok(p) = env::var(TEST_OVERRIDE_ENV) {
            if !p.is_empty() {
                return Ok((PathBuf::from(p), None));
            }
        }
    }

    let own_exe = env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let own_dir = own_exe
        .parent()
        .ok_or_else(|| "wrapper exe has no parent dir".to_string())?
        .to_path_buf();

    let raw_path = env::var_os("PATH").unwrap_or_default();
    let scrubbed: Vec<PathBuf> = env::split_paths(&raw_path)
        .filter(|p| !paths_equal(p, &own_dir))
        .collect();

    let found = find_git_on(&scrubbed)
        .ok_or_else(|| format!("git.exe not found on PATH (own dir excluded: {})", own_dir.display()))?;

    let new_path = env::join_paths(&scrubbed).map_err(|e| format!("join_paths: {e}"))?;
    Ok((found, Some(new_path)))
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    let canon_a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let canon_b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    // Windows: case-insensitive
    canon_a
        .to_string_lossy()
        .eq_ignore_ascii_case(&canon_b.to_string_lossy())
}

fn find_git_on(dirs: &[PathBuf]) -> Option<PathBuf> {
    // On Windows the extension is fixed; we don't need PATHEXT handling
    // because we're looking for the standard git.exe.
    let candidates = if cfg!(windows) {
        vec!["git.exe"]
    } else {
        vec!["git"]
    };
    for d in dirs {
        for name in &candidates {
            let p = d.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

