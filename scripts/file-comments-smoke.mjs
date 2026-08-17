#!/usr/bin/env node
/**
 * Inline file comments — CLI smoke test (feature-parity rule, ADR 009).
 *
 * Drives the imported-review loop headlessly against a real temp SQLite
 * `session.db`, mirroring how the Rust backend
 * (`src-tauri/src/code_review/file_comments.rs`), the `ado-file-comments`
 * importer, and the agent's built-in `sql` tool share ONE table — no MCP, no
 * Tauri runtime.
 *
 * Run: `npm run file-comments:smoke`
 *
 * Regression loop exercised (two bugs found via an imported ADO review):
 *   1. importer: insert a thread authored by an external reviewer's DISPLAY
 *      NAME (not 'reviewer') with ISO-8601 timestamps
 *   2. agent:    reply (author='agent', ISO-8601) + mark the root 'addressed'
 *   3. tile:     reviewer replies — historically with EPOCH-SECOND timestamps
 *   4. tile:     list the thread → the agent reply must precede the later
 *                reviewer reply (string ordering put every epoch row first)
 *   5. tile:     the imported root is NOT deletable, and attempting it must not
 *                orphan the thread by removing its replies
 *
 * The schema is copied verbatim from
 * `src-tauri/src/code_review/file_comments.rs::ensure_file_comments_schema`
 * so this smoke and the app stay in lockstep.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { commentTimeValue } from "../src/domain/comment-order.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS file_comments (
  id TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL,
  file TEXT NOT NULL,
  anchor_line_start INTEGER NOT NULL,
  anchor_line_end INTEGER NOT NULL,
  anchor_text TEXT,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_comments_ws_file
  ON file_comments(workstream_id, file, anchor_line_start);
`;

const WS = "ws-1";
const FILE = "src/backend/streams.rs";

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function insert(db, row) {
  db.prepare(
    `INSERT INTO file_comments (id, workstream_id, file, anchor_line_start, anchor_line_end,
       anchor_text, body, author, parent_id, status, created_at, updated_at)
     VALUES (@id, @workstream_id, @file, @anchor_line_start, @anchor_line_end,
       @anchor_text, @body, @author, @parent_id, @status, @created_at, @updated_at)`,
  ).run({
    workstream_id: WS,
    file: FILE,
    anchor_line_start: 12,
    anchor_line_end: 12,
    anchor_text: "let credit = 0;",
    parent_id: null,
    status: "open",
    ...row,
    updated_at: row.updated_at ?? row.created_at,
  });
}

/**
 * Mirrors the tile's list query verbatim, including the ordering key that
 * normalizes legacy epoch-second rows against ISO-8601 ones
 * (`list_file_comments_rows` in file_comments.rs).
 */
const CREATED_AT_ORDER = `CASE WHEN created_at GLOB '[0-9]*' AND created_at NOT GLOB '*[^0-9]*'
     THEN CAST(created_at AS INTEGER)
     ELSE CAST(strftime('%s', created_at) AS INTEGER) END`;

function listThread(db) {
  return db
    .prepare(
      `SELECT id, author, parent_id, status, created_at FROM file_comments
       WHERE workstream_id = ? AND file = ?
       ORDER BY anchor_line_start ASC, ${CREATED_AT_ORDER} ASC, created_at ASC`,
    )
    .all(WS, FILE);
}

/** Mirrors delete_file_comment_row: gated on the ROOT being reviewer-authored. */
function deleteThread(db, id) {
  return db
    .prepare(
      `DELETE FROM file_comments WHERE (id = ? OR parent_id = ?) AND EXISTS (
         SELECT 1 FROM file_comments root WHERE root.id = ? AND root.author = 'reviewer')`,
    )
    .run(id, id, id).changes;
}

const dir = mkdtempSync(path.join(tmpdir(), "fc-smoke-"));
const db = new Database(path.join(dir, "session.db"));

try {
  db.exec(SCHEMA);
  console.log("file_comments smoke — imported review thread\n");

  // 1. importer (ado-file-comments): external author, ISO-8601.
  insert(db, {
    id: "ado-1513151-16261206-1",
    body: "you don't need to do this with the new FFI.",
    author: "Eduardo Fernandez",
    created_at: "2026-08-16T23:51:26Z",
  });
  const root = listThread(db)[0];
  check("importer preserves the ADO display name", root.author === "Eduardo Fernandez", root.author);
  check(
    "imported author is neither of the local aliases",
    root.author !== "reviewer" && root.author !== "agent",
  );

  // 2. agent replies (ISO-8601) and marks the root addressed.
  insert(db, {
    id: "ado-1513151-16261206-1-agent",
    body: "Dropped the manual conversion.",
    author: "agent",
    parent_id: "ado-1513151-16261206-1",
    created_at: "2026-08-17T10:00:00Z",
  });
  db.prepare(`UPDATE file_comments SET status = 'addressed' WHERE id = ?`).run(
    "ado-1513151-16261206-1",
  );

  // 3. reviewer replies LATER, in the tile's legacy epoch-second format.
  const epochReply = String(Math.floor(Date.parse("2026-08-17T11:00:00Z") / 1000));
  insert(db, {
    id: "my-reply",
    body: "Confirmed, thanks.",
    author: "reviewer",
    parent_id: "ado-1513151-16261206-1",
    created_at: epochReply,
  });

  // 4. SQL ordering must be chronological for the agent reply vs the later one.
  const replies = listThread(db).filter((r) => r.parent_id);
  const agentIdx = replies.findIndex((r) => r.author === "agent");
  const mineIdx = replies.findIndex((r) => r.id === "my-reply");
  check(
    "agent reply precedes the later reviewer reply",
    agentIdx !== -1 && mineIdx !== -1 && agentIdx < mineIdx,
    `order: ${replies.map((r) => r.id).join(", ")}`,
  );
  check(
    "both timestamp formats normalize chronologically",
    commentTimeValue("2026-08-17T10:00:00Z") < commentTimeValue(epochReply),
  );

  // 5. the imported root is not deletable and its replies survive.
  const removed = deleteThread(db, "ado-1513151-16261206-1");
  check("imported root is not deletable", removed === 0, `deleted ${removed} rows`);
  check("imported thread survives intact", listThread(db).length === 3);

  // A reviewer-owned thread still deletes with its replies.
  insert(db, { id: "mine", body: "local note", author: "reviewer", created_at: "1786000000" });
  insert(db, {
    id: "mine-agent",
    body: "answer",
    author: "agent",
    parent_id: "mine",
    created_at: "2026-08-17T12:00:00Z",
  });
  check("reviewer thread deletes with its replies", deleteThread(db, "mine") === 2);
  check("only the imported thread remains", listThread(db).length === 3);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
