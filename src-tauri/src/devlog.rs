//! Devlog export.
//!
//! Writes a generated day page into the user's wiki and, optionally, commits
//! and pushes it. This is the highest blast-radius code in the application:
//! the target folder holds a year of hand-written work log that exists in no
//! other form, and a bad overwrite would be unrecoverable.
//!
//! The guard is therefore conservative in one specific direction. A file is
//! only ever replaced if it *proves* it came from us, by carrying our
//! `generated_by` key inside leading YAML front matter. Anything else -- a
//! hand-written page, a page with somebody else's front matter, an empty file,
//! an unreadable file -- causes the export to write alongside under a
//! `.workstreams.md` suffix and report a warning, rather than to guess.
//!
//! Export is one-way by design. Nothing here ever reads a page back into the
//! database, so the wiki stays a searchable archive rather than a second
//! source of truth that would need conflict resolution.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Front-matter key proving a page came from this app. Must stay identical to
/// `GENERATED_BY_MARKER` in `src/domain/devlog-render.ts`.
const GENERATED_BY_MARKER: &str = "generated_by: workstreams";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevlogExportResult {
    /// Absolute path actually written.
    pub path: String,
    /// True when the intended path was occupied by a file we did not generate.
    pub wrote_alongside: bool,
    /// Non-fatal explanation shown to the user; empty when all went well.
    pub warning: String,
    /// Commit SHA, or empty when committing was skipped or failed.
    pub commit: String,
    /// True when the commit was pushed to the remote.
    pub pushed: bool,
}

/// Whether a page was produced by our renderer.
///
/// Strict on purpose: only leading front matter containing our exact marker
/// counts. See the module docs for why the failure mode has to be "refuse",
/// not "assume".
pub fn is_generated_by_us(content: &str) -> bool {
    // Tolerate ONE leading UTF-8 BOM and CRLF, which editors add freely, but
    // nothing else. "Exactly one" and the explicit ASCII-only trailing set
    // below are what keep this bit-for-bit equivalent to `isGeneratedByUs` in
    // src/domain/devlog-render.ts. Rust's `trim_end` and JavaScript's `\s`
    // disagree about Unicode whitespace (notably U+FEFF and U+0085), and a
    // disagreement here means the CLI and the UI hold different opinions about
    // which of the user's files may be destroyed.
    let body = content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .replace("\r\n", "\n");
    let Some(rest) = body.strip_prefix("---\n") else {
        return false;
    };
    let Some(end) = rest.find("\n---") else {
        return false;
    };
    // Exact line match, not `contains`. A substring test would accept
    // `not_generated_by: workstreams` or `generated_by: workstreams-backup`
    // and hand us permission to destroy somebody else's file.
    rest[..end]
        .lines()
        .any(|line| line.trim_end_matches([' ', '\t', '\r']) == GENERATED_BY_MARKER)
}

/// Whether a date is a plain canonical `YYYY-MM-DD`.
///
/// The command is a public API surface (the CLI can call it too), and the value
/// is interpolated straight into a path -- so `../../notes/x` must never get
/// that far.
fn is_safe_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| match i {
        4 | 7 => *b == b'-',
        _ => b.is_ascii_digit(),
    })
}

/// Candidate paths for a day, in the order they are tried.
///
/// The intended name first, then `<date>.workstreams.md` and numbered
/// variants. Rust, `MemoryBackend.exportDevlogDay` and `scripts/tasks-smoke.mjs`
/// must all produce this identical sequence.
fn candidate_paths(dir: &Path, date: &str) -> Vec<PathBuf> {
    let mut out = vec![dir.join(format!("{date}.md"))];
    out.push(dir.join(format!("{date}.workstreams.md")));
    for n in 1..100 {
        out.push(dir.join(format!("{date}.workstreams.{n}.md")));
    }
    out
}

/// Write `content` to `path` only if the path is genuinely ours to write.
///
/// Returns `Ok(true)` when written, `Ok(false)` when the path is occupied by
/// something we did not generate (or could not verify) and the caller should
/// try the next candidate.
///
/// This is deliberately handle-based rather than check-then-write, which is
/// what makes the safety property absolute rather than merely likely:
///
/// - For an absent path, `create_new` is atomic and symlink-safe: `O_CREAT |
///   O_EXCL` fails rather than following a symlink or clobbering a file that
///   appeared in between.
/// - For an existing path, the file is opened **without** truncation, verified
///   by reading through that same handle, and only then truncated and
///   rewritten. Whatever the directory entry does afterwards, the bytes we
///   destroy are the bytes we verified. A symlink is therefore harmless too:
///   we would only ever truncate its target if that target is itself a page we
///   generated.
fn write_verified(path: &Path, content: &str) -> Result<bool, String> {
    use std::io::{Read, Seek, SeekFrom, Write};

    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(content.as_bytes())
                .map_err(|e| format!("write {}: {e}", path.display()))?;
            return Ok(true);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        // Anything else (permissions, I/O) is not a licence to keep going at
        // this path, but other candidates may still work.
        Err(_) => return Ok(false),
    }

    let Ok(mut file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    else {
        return Ok(false);
    };

    let mut existing = String::new();
    if file.read_to_string(&mut existing).is_err() {
        // Unreadable, or not UTF-8. Inability to verify is never permission to
        // destroy.
        return Ok(false);
    }
    if !is_generated_by_us(&existing) {
        return Ok(false);
    }

    file.set_len(0)
        .map_err(|e| format!("truncate {}: {e}", path.display()))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("seek {}: {e}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(true)
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::git_command()
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Write the page, then optionally commit and push it.
///
/// Commit and push failures are reported but never discard the written file:
/// losing the day's export because a remote was unreachable would be a worse
/// outcome than an uncommitted file the user can commit later.
pub fn write_and_commit(
    dir: &Path,
    date: &str,
    content: &str,
    commit: bool,
    push: bool,
) -> Result<DevlogExportResult, String> {
    if !is_safe_date(date) {
        return Err(format!("invalid devlog date: {date}"));
    }
    if !dir.is_dir() {
        return Err(format!(
            "devlog directory does not exist: {}",
            dir.display()
        ));
    }

    // Try each candidate in turn. Selection and writing are the same operation
    // -- there is no separate "check" that reality could invalidate.
    let mut written: Option<PathBuf> = None;
    let mut index = 0usize;
    for (i, candidate) in candidate_paths(dir, date).into_iter().enumerate() {
        if write_verified(&candidate, content)? {
            index = i;
            written = Some(candidate);
            break;
        }
    }

    let Some(path) = written else {
        return Err(format!(
            "refusing to write: {date}.md and every alongside name are files Workstreams did not generate"
        ));
    };

    let wrote_alongside = index > 0;
    let warning = if wrote_alongside {
        format!(
            "{date}.md was not generated by Workstreams, so it was left untouched \
             and the export was written alongside it."
        )
    } else {
        String::new()
    };

    let mut result = DevlogExportResult {
        path: path.display().to_string(),
        wrote_alongside,
        warning,
        commit: String::new(),
        pushed: false,
    };

    if !commit {
        return Ok(result);
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    if let Err(e) = git(dir, &["add", "--", &file_name]) {
        result.warning = join_warning(&result.warning, &format!("git add failed: {e}"));
        return Ok(result);
    }

    // Nothing staged means the page is unchanged since the last export, which
    // is a perfectly normal no-op rather than an error.
    // Scoped to our file. An unscoped check would report "changes" whenever
    // the user happened to have unrelated work staged in the wiki repo.
    if git(dir, &["diff", "--cached", "--quiet", "--", &file_name]).is_ok() {
        result.warning = join_warning(&result.warning, "no changes to commit");
        return Ok(result);
    }

    let message = format!("devlog: {date}");
    // Pathspec-scoped commit, so an export can never sweep up unrelated staged
    // changes the user was still working on.
    if let Err(e) = git(dir, &["commit", "-m", &message, "--", &file_name]) {
        result.warning = join_warning(&result.warning, &format!("git commit failed: {e}"));
        return Ok(result);
    }

    result.commit = git(dir, &["rev-parse", "HEAD"]).unwrap_or_default();

    if push {
        match git(dir, &["push"]) {
            Ok(_) => result.pushed = true,
            Err(e) => {
                result.warning = join_warning(&result.warning, &format!("git push failed: {e}"));
            }
        }
    }

    Ok(result)
}

fn join_warning(existing: &str, extra: &str) -> String {
    if existing.is_empty() {
        extra.to_string()
    } else {
        format!("{existing} {extra}")
    }
}

/// Render is done in TypeScript; this command only persists the result.
#[tauri::command]
pub fn export_devlog_day(
    directory: String,
    date: String,
    content: String,
    commit: Option<bool>,
    push: Option<bool>,
) -> Result<DevlogExportResult, String> {
    write_and_commit(
        Path::new(&directory),
        &date,
        &content,
        commit.unwrap_or(true),
        push.unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ws_devlog_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const GENERATED: &str =
        "---\ndate: 2026-08-19\ngenerated_by: workstreams\n---\n\n# 2026-08-19\n";

    /// A real hand-written page, copied in shape from the user's archive.
    const HAND_WRITTEN: &str = "## AudioTranscoding\n\
        - 👁️Waiting on Marcus for bug fix review\n\
        \t- ✅This one couldnt replicate, seems to be a no issue\n";

    #[test]
    fn recognises_its_own_output() {
        assert!(is_generated_by_us(GENERATED));
    }

    #[test]
    fn refuses_to_claim_a_hand_written_page() {
        assert!(!is_generated_by_us(HAND_WRITTEN));
    }

    #[test]
    fn refuses_front_matter_that_is_not_ours() {
        assert!(!is_generated_by_us(
            "---\ndate: 2026-08-19\ntags: [work]\n---\n# hi\n"
        ));
    }

    #[test]
    fn refuses_an_empty_or_truncated_file() {
        assert!(!is_generated_by_us(""));
        assert!(!is_generated_by_us(
            "---\ndate: 2026-08-19\ngenerated_by: workstreams\n"
        ));
    }

    #[test]
    fn rejects_a_date_that_could_escape_the_devlog_directory() {
        let dir = temp_dir("traversal");
        for bad in ["../../etc/passwd", "2026-08-19/../x", "..", "2026-8-19", ""] {
            let err = write_and_commit(&dir, bad, GENERATED, false, false).unwrap_err();
            assert!(err.contains("invalid devlog date"), "accepted {bad:?}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_marker_that_only_looks_like_ours() {
        // A substring test would hand us permission to destroy these.
        assert!(!is_generated_by_us(
            "---\nnot_generated_by: workstreams\n---\n"
        ));
        assert!(!is_generated_by_us(
            "---\ngenerated_by: workstreams-backup\n---\n"
        ));
        assert!(!is_generated_by_us(
            "---\n# generated_by: workstreams-ish\n---\n"
        ));
    }

    #[test]
    fn agrees_with_the_typescript_twin_on_bom_and_whitespace_edges() {
        // These are exactly the inputs where Rust's Unicode-aware trimming and
        // JavaScript's `\s` used to diverge. A disagreement means the CLI and
        // the UI differ on which files may be destroyed.
        assert!(!is_generated_by_us(
            "\u{feff}\u{feff}---\ngenerated_by: workstreams\n---\n"
        ));
        assert!(!is_generated_by_us(
            "---\ngenerated_by: workstreams\u{feff}\n---\n"
        ));
        assert!(!is_generated_by_us(
            "---\ngenerated_by: workstreams\u{a0}\n---\n"
        ));
        assert!(is_generated_by_us(
            "---\ngenerated_by: workstreams  \t\n---\n"
        ));
    }

    #[test]
    fn tolerates_crlf_and_a_byte_order_mark() {
        assert!(is_generated_by_us(
            "---\r\ndate: x\r\ngenerated_by: workstreams\r\n---\r\n"
        ));
        assert!(is_generated_by_us(
            "\u{feff}---\ndate: x\ngenerated_by: workstreams\n---\n"
        ));
    }

    #[test]
    fn never_clobbers_a_hand_written_alongside_file_either() {
        // Stepping aside is pointless if the place we step to is also the
        // user's. Both names here are hand-written.
        let dir = temp_dir("alongside");
        std::fs::write(dir.join("2026-08-19.md"), HAND_WRITTEN).unwrap();
        std::fs::write(dir.join("2026-08-19.workstreams.md"), HAND_WRITTEN).unwrap();

        let result = write_and_commit(&dir, "2026-08-19", GENERATED, false, false).unwrap();

        assert!(result.path.ends_with("2026-08-19.workstreams.1.md"));
        for name in ["2026-08-19.md", "2026-08-19.workstreams.md"] {
            assert_eq!(
                std::fs::read_to_string(dir.join(name)).unwrap(),
                HAND_WRITTEN,
                "{name} was modified"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_symlink_into_someone_elses_file() {
        // fs::write follows symlinks and truncates the target, so a symlinked
        // day file is a way to destroy an arbitrary file on disk.
        let dir = temp_dir("symlink");
        let secret = dir.join("important.md");
        std::fs::write(&secret, "precious hand-written notes").unwrap();
        std::os::unix::fs::symlink(&secret, dir.join("2026-08-19.md")).unwrap();

        let result = write_and_commit(&dir, "2026-08-19", GENERATED, false, false).unwrap();

        assert!(result.wrote_alongside);
        assert_eq!(
            std::fs::read_to_string(&secret).unwrap(),
            "precious hand-written notes",
            "the symlink target was overwritten"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writes_straight_to_the_day_file_when_nothing_is_there() {
        let dir = temp_dir("fresh");
        let result = write_and_commit(&dir, "2026-08-19", GENERATED, false, false).unwrap();
        assert!(result.path.ends_with("2026-08-19.md"));
        assert!(!result.wrote_alongside);
        assert!(result.warning.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replaces_a_page_it_generated_earlier() {
        let dir = temp_dir("regen");
        std::fs::write(dir.join("2026-08-19.md"), GENERATED).unwrap();
        let updated = format!("{GENERATED}\n## New section\n");
        let result = write_and_commit(&dir, "2026-08-19", &updated, false, false).unwrap();

        assert!(!result.wrote_alongside);
        let on_disk = std::fs::read_to_string(dir.join("2026-08-19.md")).unwrap();
        assert!(on_disk.contains("New section"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replacing_a_longer_page_leaves_no_tail_behind() {
        // The write goes through an existing handle, so without set_len(0) the
        // old bytes past the new end would survive and corrupt the page.
        let dir = temp_dir("truncate");
        let long = format!("{GENERATED}{}", "x".repeat(5000));
        std::fs::write(dir.join("2026-08-19.md"), &long).unwrap();

        write_and_commit(&dir, "2026-08-19", GENERATED, false, false).unwrap();

        let on_disk = std::fs::read_to_string(dir.join("2026-08-19.md")).unwrap();
        assert_eq!(on_disk, GENERATED, "stale tail survived the rewrite");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_one_of_our_own_pages_is_followed_safely() {
        // Verification happens through the opened handle, so a symlink is only
        // harmful if its target is not ours -- and then it is refused. Pointing
        // at our own page is legitimate and must keep working.
        let dir = temp_dir("symlink_ours");
        let real = dir.join("real.md");
        std::fs::write(&real, GENERATED).unwrap();
        std::os::unix::fs::symlink(&real, dir.join("2026-08-19.md")).unwrap();

        let updated = format!("{GENERATED}\n## Added\n");
        let result = write_and_commit(&dir, "2026-08-19", &updated, false, false).unwrap();

        assert!(!result.wrote_alongside);
        assert!(std::fs::read_to_string(&real).unwrap().contains("Added"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn never_overwrites_a_hand_written_day() {
        // The single most important test in this module: the user's archive is
        // a year of work that exists nowhere else.
        let dir = temp_dir("handwritten");
        let target = dir.join("2026-08-19.md");
        std::fs::write(&target, HAND_WRITTEN).unwrap();

        let result = write_and_commit(&dir, "2026-08-19", GENERATED, false, false).unwrap();

        assert!(result.wrote_alongside);
        assert!(result.path.ends_with("2026-08-19.workstreams.md"));
        assert!(!result.warning.is_empty());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            HAND_WRITTEN,
            "the hand-written page was modified"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn errors_rather_than_creating_a_missing_devlog_directory() {
        // Silently creating the folder would hide a mistyped path and scatter
        // generated pages somewhere the user never looks.
        let dir = temp_dir("missing").join("nope");
        let err = write_and_commit(&dir, "2026-08-19", GENERATED, false, false).unwrap_err();
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn commits_the_page_in_a_git_repo() {
        let dir = temp_dir("git");
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            git(&dir, &args).unwrap();
        }

        let result = write_and_commit(&dir, "2026-08-19", GENERATED, true, false).unwrap();
        assert!(!result.commit.is_empty(), "warning was: {}", result.warning);
        assert!(!result.pushed);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reports_a_commit_failure_without_discarding_the_written_page() {
        // Not a git repo, so committing cannot work -- but the file the user
        // asked for must still be on disk.
        let dir = temp_dir("nogit");
        let result = write_and_commit(&dir, "2026-08-19", GENERATED, true, false).unwrap();

        assert!(result.commit.is_empty());
        assert!(!result.warning.is_empty());
        assert!(dir.join("2026-08-19.md").exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
