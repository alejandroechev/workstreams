//! Pure anchor / diff / classify engine for Local Agent Review (ADR 013).
//!
//! Ported from the de-risking spike
//! (`features/local-agent-review/prototypes/trackability/spike.js`, verdict GO).
//!
//! This module is intentionally **pure and synchronous**: it takes strings
//! (the new file text + a `git diff` for one file) and returns a
//! classification. All `git` invocation and the per-snapshot re-anchor sweep
//! live in the backend and run off the UI/command thread (ADR 013 §8,
//! non-blocking discipline). Keeping the algorithm pure makes it unit-testable
//! without a live repo or the Tauri runtime.

use sha2::{Digest, Sha256};

/// A comment's anchor: the exact text block it was attached to at capture time,
/// its 1-based line range, and a content hash for fast equality.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub start: usize, // 1-based, inclusive
    pub end: usize,   // 1-based, inclusive
    pub anchor_text: String,
    pub hash: String,
}

/// The binary anchor state (ADR 013 §7 — spike proved a 4-state split is
/// unreliable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorState {
    /// The exact commented block still exists (possibly shifted). Re-anchor.
    Unchanged,
    /// The commented lines were edited or deleted. Surface before/after.
    Changed,
}

/// One unified-diff hunk for a single file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub patch: String,
}

/// Result of classifying one anchor against a new snapshot + its diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classification {
    pub state: AnchorState,
    /// New 1-based line the comment re-anchors to (when the block still exists).
    pub new_line: Option<usize>,
    pub moved: bool,
    /// The touching hunk(s) — the per-comment before/after (when `Changed`).
    pub fixing_hunk: Option<String>,
    /// Informational hint only: the change was pure deletion. Never a gate.
    pub deleted_only: bool,
}

/// sha256 hex of a string.
pub fn sha_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// Capture an anchor from `text` over the 1-based inclusive range `start..=end`.
pub fn capture_anchor(text: &str, start: usize, end: usize) -> Anchor {
    let lines: Vec<&str> = text.split('\n').collect();
    let s = start.saturating_sub(1);
    let e = end.min(lines.len());
    let anchor_text = if s < e {
        lines[s..e].join("\n")
    } else {
        String::new()
    };
    let hash = sha_hex(&anchor_text);
    Anchor {
        start,
        end,
        anchor_text,
        hash,
    }
}

/// Find the exact anchor block in `new_text`, preferring the occurrence whose
/// start line is nearest the anchor's original line (spike caveat: identical
/// text can appear more than once). Returns the 1-based start line if found.
pub fn relocate_by_text(new_text: &str, anchor: &Anchor) -> Option<usize> {
    if anchor.anchor_text.is_empty() {
        return None;
    }
    let lines: Vec<&str> = new_text.split('\n').collect();
    let needle: Vec<&str> = anchor.anchor_text.split('\n').collect();
    if needle.len() > lines.len() {
        return None;
    }
    let mut best: Option<usize> = None;
    let mut best_dist = usize::MAX;
    for i in 0..=(lines.len() - needle.len()) {
        if lines[i..i + needle.len()] == needle[..] {
            let new_start = i + 1;
            let dist = new_start.abs_diff(anchor.start);
            if dist < best_dist {
                best_dist = dist;
                best = Some(new_start);
            }
        }
    }
    best
}

/// Parse a `@@ -a,b +c,d @@` header. `b`/`d` default to 1 when omitted.
fn parse_hunk_header(line: &str) -> Option<(usize, usize, usize, usize)> {
    if !line.starts_with("@@") {
        return None;
    }
    let mut old = None;
    let mut new = None;
    for tok in line.split_whitespace() {
        if let Some(rest) = tok.strip_prefix('-') {
            old = Some(rest);
        } else if let Some(rest) = tok.strip_prefix('+') {
            new = Some(rest);
        }
    }
    let parse = |t: &str| -> Option<(usize, usize)> {
        let mut it = t.split(',');
        let start = it.next()?.parse::<usize>().ok()?;
        let lines = match it.next() {
            Some(n) => n.parse::<usize>().ok()?,
            None => 1,
        };
        Some((start, lines))
    };
    let (os, ol) = parse(old?)?;
    let (ns, nl) = parse(new?)?;
    Some((os, ol, ns, nl))
}

/// Parse unified `git diff` output for a single file into hunks.
pub fn parse_hunks(diff: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut cur: Option<Hunk> = None;
    for line in diff.split('\n') {
        if let Some((os, ol, ns, nl)) = parse_hunk_header(line) {
            if let Some(h) = cur.take() {
                hunks.push(h);
            }
            cur = Some(Hunk {
                old_start: os,
                old_lines: ol,
                new_start: ns,
                new_lines: nl,
                patch: format!("{line}\n"),
            });
        } else if let Some(h) = cur.as_mut() {
            let first = line.chars().next();
            if matches!(first, Some(' ') | Some('+') | Some('-') | Some('\\')) || line.is_empty() {
                h.patch.push_str(line);
                h.patch.push('\n');
            } else {
                // A non-hunk line (e.g. the next file header) ends the hunk.
                hunks.push(cur.take().unwrap());
            }
        }
    }
    if let Some(h) = cur.take() {
        hunks.push(h);
    }
    hunks
}

/// Does a hunk's OLD-side range intersect the anchor's original `[start,end]`?
/// A pure insertion (`old_lines == 0`) has an empty old range and never touches.
pub fn hunk_touches_anchor(h: &Hunk, anchor: &Anchor) -> bool {
    let old_start = h.old_start as i64;
    let old_end = old_start + h.old_lines as i64 - 1;
    old_start <= anchor.end as i64 && old_end >= anchor.start as i64
}

/// Classify an anchor against a new snapshot and its (single-file) diff.
///
/// - `Unchanged` when the exact block still exists AND nothing edited its old
///   range → re-anchor to the new line.
/// - `Changed` otherwise → the touching hunk(s) are the per-comment
///   before/after. The fixing commit is resolved by the caller (git), not here.
pub fn classify(new_text: &str, diff: &str, anchor: &Anchor) -> Classification {
    let relocated = relocate_by_text(new_text, anchor);
    let hunks = parse_hunks(diff);
    let touching: Vec<&Hunk> = hunks
        .iter()
        .filter(|h| hunk_touches_anchor(h, anchor))
        .collect();

    if let Some(new_line) = relocated {
        if touching.is_empty() {
            return Classification {
                state: AnchorState::Unchanged,
                new_line: Some(new_line),
                moved: new_line != anchor.start,
                fixing_hunk: None,
                deleted_only: false,
            };
        }
    }

    let chosen: Vec<&Hunk> = if touching.is_empty() {
        hunks.iter().collect()
    } else {
        touching
    };
    let deleted_only = !chosen.is_empty() && chosen.iter().all(|h| !h.patch.contains("\n+"));
    let fixing_hunk: String = chosen.iter().map(|h| h.patch.as_str()).collect();

    Classification {
        state: AnchorState::Changed,
        new_line: relocated,
        moved: relocated.map(|l| l != anchor.start).unwrap_or(false),
        fixing_hunk: if fixing_hunk.is_empty() {
            None
        } else {
            Some(fixing_hunk)
        },
        deleted_only,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "export function auth(token) {\n  // verify the JWT\n  const decoded = verify(token);\n  console.log(\"debug: decoded\", decoded);\n  if (!decoded) {\n    return null;\n  }\n  return decoded.user;\n}\n";

    fn anchor() -> Anchor {
        // Line 4 = the console.log the reviewer flagged.
        capture_anchor(BASE, 4, 4)
    }

    #[test]
    fn capture_anchor_extracts_line_and_hashes() {
        let a = anchor();
        assert_eq!(a.anchor_text, "  console.log(\"debug: decoded\", decoded);");
        assert_eq!(a.hash, sha_hex(&a.anchor_text));
        assert_eq!(a.hash.len(), 64);
    }

    #[test]
    fn parse_hunk_header_handles_omitted_counts() {
        assert_eq!(parse_hunk_header("@@ -3,3 +3,2 @@ ctx"), Some((3, 3, 3, 2)));
        assert_eq!(parse_hunk_header("@@ -5 +5 @@"), Some((5, 1, 5, 1)));
        assert_eq!(parse_hunk_header("not a hunk"), None);
    }

    #[test]
    fn hunk_touches_anchor_ignores_pure_insertion() {
        let a = anchor();
        // Pure insertion of 2 lines at top: old range empty.
        let ins = Hunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: 2,
            patch: String::new(),
        };
        assert!(!hunk_touches_anchor(&ins, &a));
        // Deletion covering line 4 touches.
        let del = Hunk {
            old_start: 3,
            old_lines: 3,
            new_start: 3,
            new_lines: 2,
            patch: String::new(),
        };
        assert!(hunk_touches_anchor(&del, &a));
    }

    // ── The three spike scenarios (evidence parity) ──────────────────────────

    #[test]
    fn scenario_a_shift_above_is_unchanged_and_reanchored() {
        let new_text = "import { verify } from \"./jwt\";\nimport { clearSession } from \"./session\";\n\nexport function auth(token) {\n  // verify the JWT\n  const decoded = verify(token);\n  console.log(\"debug: decoded\", decoded);\n  if (!decoded) {\n    return null;\n  }\n  return decoded.user;\n}\n";
        // Inserting 3 lines above: git emits an insertion hunk not touching line 4.
        let diff = "@@ -1,0 +1,3 @@\n+import { verify } from \"./jwt\";\n+import { clearSession } from \"./session\";\n+\n";
        let c = classify(new_text, diff, &anchor());
        assert_eq!(c.state, AnchorState::Unchanged);
        assert_eq!(c.new_line, Some(7));
        assert!(c.moved);
        assert!(c.fixing_hunk.is_none());
    }

    #[test]
    fn scenario_b_removed_line_is_changed_with_before_after() {
        let new_text = "export function auth(token) {\n  // verify the JWT\n  const decoded = verify(token);\n  if (!decoded) {\n    return null;\n  }\n  return decoded.user;\n}\n";
        let diff = "@@ -3,3 +3,2 @@ export function auth(token) {\n   const decoded = verify(token);\n-  console.log(\"debug: decoded\", decoded);\n   if (!decoded) {\n";
        let c = classify(new_text, diff, &anchor());
        assert_eq!(c.state, AnchorState::Changed);
        assert!(
            c.deleted_only,
            "removing the flagged line is a pure deletion"
        );
        let hunk = c.fixing_hunk.expect("must surface the before/after hunk");
        assert!(hunk.contains("-  console.log(\"debug: decoded\", decoded);"));
    }

    #[test]
    fn scenario_c_function_rewritten_away_is_changed() {
        let new_text = "export function logout() {\n  clearSession();\n}\n";
        let diff = "@@ -1,11 +1 @@\n-export function auth(token) {\n-  // verify the JWT\n-  const decoded = verify(token);\n-  console.log(\"debug: decoded\", decoded);\n-  if (!decoded) {\n-    return null;\n-  }\n-  return decoded.user;\n-}\n-\n export function logout() {\n";
        let c = classify(new_text, diff, &anchor());
        assert_eq!(c.state, AnchorState::Changed);
        assert_eq!(c.new_line, None, "block no longer exists");
        assert!(c
            .fixing_hunk
            .unwrap()
            .contains("-  console.log(\"debug: decoded\", decoded);"));
    }

    #[test]
    fn relocate_prefers_occurrence_nearest_original_line() {
        // Two identical anchor lines; the anchor was originally at line 5.
        let a = capture_anchor("x\n  dup();\ny\nz\n  dup();\n", 5, 5);
        // In the new text, dup() appears at line 2 and line 5; nearest to 5 is 5.
        let found = relocate_by_text("a\n  dup();\nb\nc\n  dup();\n", &a);
        assert_eq!(found, Some(5));
    }
}
