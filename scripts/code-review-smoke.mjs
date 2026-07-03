#!/usr/bin/env node
/**
 * Code Review tile — CLI smoke test (feature-parity rule, ADR 014).
 *
 * Drives the full local-review loop headlessly against a real temp SQLite
 * `session.db`, mirroring how the Rust backend (`src-tauri/src/code_review`)
 * and the agent's built-in `sql` tool interact with the SAME database — no
 * MCP, no Tauri runtime.
 *
 * Run: `npm run code-review:smoke`
 *
 * Loop exercised:
 *   1. tile:   ensure_review_schema + create a `working_tree` review
 *   2. tile:   reviewer adds two inline comments (author='reviewer', status='open')
 *   3. agent:  SELECT open reviewer comments (its own sql tool),
 *              INSERT a threaded reply (author='agent'), UPDATE parent -> 'addressed'
 *   4. tile:   poll sees the agent replies + addressed status
 *   5. tile:   reviewer resolves both threads (reviewer-only 'resolved')
 *   6. tile:   complete the review (status open -> completed)
 *
 * The schema below is copied verbatim from
 * `src-tauri/src/code_review/mod.rs::ensure_review_schema` so this smoke and
 * the app stay in lockstep.
 */

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function id(prefix) {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}
function nowIso() {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL,
  diff_source TEXT NOT NULL,
  base_ref TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS review_comments (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  side TEXT NOT NULL DEFAULT 'new',
  code TEXT,
  hunk_header TEXT,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_comments_review ON review_comments(review_id, file, line);
`;

const results = [];
function check(label, cond) {
  results.push({ label, ok: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${label}`);
}

// ── The tile / Rust backend surface (opens the session.db read-write). ──
function ensureReviewSchema(db) {
  db.exec(SCHEMA);
}
function createReview(db, workstreamId, diffSource, baseRef) {
  const now = nowIso();
  const rid = id("rev");
  db.prepare(
    `INSERT INTO reviews (id, workstream_id, diff_source, base_ref, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(rid, workstreamId, diffSource, baseRef, null, now, now);
  return rid;
}
function addReviewerComment(db, reviewId, file, line, code, body) {
  const now = nowIso();
  const cid = id("c");
  db.prepare(
    `INSERT INTO review_comments (id, review_id, file, line, side, code, hunk_header, body, author, parent_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new', ?, NULL, ?, 'reviewer', NULL, 'open', ?, ?)`,
  ).run(cid, reviewId, file, line, code, body, now, now);
  return cid;
}
function listComments(db, reviewId) {
  return db
    .prepare(`SELECT * FROM review_comments WHERE review_id = ? ORDER BY created_at`)
    .all(reviewId);
}
function setStatus(db, commentId, status) {
  db.prepare(`UPDATE review_comments SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    nowIso(),
    commentId,
  );
}
function completeReview(db, reviewId) {
  const now = nowIso();
  db.prepare(
    `UPDATE reviews SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, reviewId);
}

// ── The agent surface (its native `sql` tool on the SAME db). Follows the
//    code-review skill contract: never edits reviewer rows, never sets
//    'resolved'; replies + marks 'addressed'. ──
function agentAddressOpenComments(db) {
  const open = db
    .prepare(
      `SELECT id, review_id, file, line, side, code, hunk_header, body
       FROM review_comments WHERE status = 'open' AND author = 'reviewer' ORDER BY file, line`,
    )
    .all();
  for (const c of open) {
    const now = nowIso();
    db.prepare(
      `INSERT INTO review_comments (id, review_id, file, line, side, code, hunk_header, body, author, parent_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'agent', ?, 'open', ?, ?)`,
    ).run(id("a"), c.review_id, c.file, c.line, c.side, `Addressed: ${c.body}`, c.id, now, now);
    db.prepare(`UPDATE review_comments SET status = 'addressed', updated_at = ? WHERE id = ?`).run(
      now,
      c.id,
    );
  }
  return open.length;
}

function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "cr-smoke-"));
  const dbPath = path.join(dir, "session.db");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    console.log(`session.db: ${dbPath}\n`);

    // 1. tile: schema + create review
    ensureReviewSchema(db);
    const rid = createReview(db, "ws-smoke", "working_tree", null);
    const rev = db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(rid);
    check("review created (status=open, working_tree)", rev.status === "open" && rev.diff_source === "working_tree");

    // 2. tile: reviewer adds two inline comments
    const c1 = addReviewerComment(db, rid, "src/a.js", 12, "  console.log(x)", "Remove this debug log");
    const c2 = addReviewerComment(db, rid, "src/b.ts", 3, "let y = 1", "Prefer const here");
    const openReviewer = listComments(db, rid).filter((c) => c.author === "reviewer" && c.status === "open");
    check("two open reviewer comments", openReviewer.length === 2);

    // 3. agent (separate DB handle to prove no-lock cross-connection contention)
    const agentDb = new Database(dbPath);
    agentDb.pragma("busy_timeout = 5000");
    const addressed = agentAddressOpenComments(agentDb);
    agentDb.close();
    check("agent addressed both comments", addressed === 2);

    // 4. tile: poll sees replies + addressed status
    const after = listComments(db, rid);
    const replies = after.filter((c) => c.author === "agent" && c.parent_id);
    const parentsAddressed = after.filter((c) => c.author === "reviewer" && c.status === "addressed");
    check("two agent replies threaded via parent_id", replies.length === 2 && replies.every((r) => r.parent_id));
    check("both reviewer comments now 'addressed'", parentsAddressed.length === 2);
    check("agent never set 'resolved'", after.every((c) => !(c.author === "agent" && c.status === "resolved")));

    // 5. tile: reviewer resolves both threads
    setStatus(db, c1, "resolved");
    setStatus(db, c2, "resolved");
    const resolved = listComments(db, rid).filter((c) => c.author === "reviewer" && c.status === "resolved");
    check("reviewer resolved both threads", resolved.length === 2);

    // 6. tile: complete the review
    completeReview(db, rid);
    const done = db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(rid);
    check("review completed (status=completed, completed_at set)", done.status === "completed" && !!done.completed_at);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error(`FAIL: ${failed.map((f) => f.label).join("; ")}`);
    process.exit(1);
  }
  console.log("Code Review smoke: PASS");
}

main();
