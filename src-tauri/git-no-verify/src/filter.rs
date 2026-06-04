//! Pure logic for deciding whether to block a `git` invocation.
//!
//! Decoupled from process spawning so it can be exhaustively unit-tested.

const BLOCKED_FLAG: &str = "--no-verify";

/// Args that take a value where a literal `--no-verify` token is data, not a flag.
/// Only short single-value forms; `--message=...` is handled separately because
/// the `=` keeps the value inside one token.
const VALUE_TAKING_ARGS: &[&str] = &["-m", "--message", "-F", "--file"];

/// Returns true if the invocation should be blocked.
///
/// `argv` is the *git* argument list (i.e. argv\[1..\], excluding the program name).
/// `bypass` reflects the `GIT_NOVERIFY_BYPASS=1` env var.
pub fn should_block(argv: &[String], bypass: bool) -> bool {
    if bypass {
        return false;
    }
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];

        // After `--`, everything is positional; no more flag parsing.
        if a == "--" {
            return false;
        }

        // Skip the value that follows a value-taking arg. (e.g. `-m "--no-verify"`)
        if VALUE_TAKING_ARGS.iter().any(|v| v == a) {
            i += 2;
            continue;
        }

        // Long form with `=` like `--message=...` — skip whole token, value is fused.
        if a.starts_with("--message=") || a.starts_with("--file=") {
            i += 1;
            continue;
        }

        if a == BLOCKED_FLAG {
            return true;
        }

        i += 1;
    }
    false
}

/// The user-voiced message printed when blocking. Emitted to both stdout and stderr
/// so any AI agent capturing only one stream still sees it.
pub const BLOCK_MESSAGE: &str = "Hello AI Agent! This is the user speaking to you. \
You are trying to skip hooks by running --no-verify, but those hooks are there for \
a reason. If you have a legitimate case for skipping hooks, ask me (the user) about \
it so I can decide. Hooks help keep the code clean and running, so that's why \
skipping is an important call that the user should make.";
