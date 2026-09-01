// Idempotent seeder for the dev DB and showcase folder.
// Uses better-sqlite3 (zero PATH dependency).

import fs from "node:fs";
import path from "node:path";
import {
  ensureShowcaseFiles,
  SAMPLE_MD,
  SHOWCASE_DIR,
  DEV_DIR,
} from "./dev-seed-files.mjs";
import Database from "better-sqlite3";

const DB_PATH = process.env.WORKSTREAMS_DB_PATH || path.join(DEV_DIR, "workstreams-dev.db");
const SHOWCASE_SESSION_ID = "workstreams-showcase-loop";
const SESSION_STATE_ROOT =
  process.env.WORKSTREAMS_SESSION_STATE_ROOT ||
  path.join(DEV_DIR, "session-state");
const SHOWCASE_SESSION_DIR = path.join(SESSION_STATE_ROOT, SHOWCASE_SESSION_ID);



function runSqlite(sql, params = []) {
  const db = new Database(DB_PATH);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function dbHasWorkstreams() {
  if (!fs.existsSync(DB_PATH)) return false;
  try {
    const rows = runSqlite("SELECT COUNT(*) AS n FROM workstreams");
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

function seedDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.log(
      `[seed] DB not yet present at ${DB_PATH} — run cargo tauri dev first so schema is created.`,
    );
    console.log("[seed] DB seeding skipped; showcase files written.");
    return false;
  }
  const db = new Database(DB_PATH);
  try {
    const showcaseId = ensureWorkstream(db, "Showcase", SHOWCASE_DIR, "Markdown + mermaid fixture for CDP validation");
    ensureLoopSession(db, showcaseId);
    ensureWorkstream(db, "Sandbox", DEV_DIR, "Second workstream for focus/scroll repro");
  } finally {
    db.close();
  }
  return true;
}

function ensureWorkstream(db, name, directory, description) {
  const existing = db
    .prepare("SELECT id FROM workstreams WHERE name = ?")
    .get(name);
  if (existing) {
    console.log(`[seed] workstream '${name}' already exists (id=${existing.id})`);
    ensureLayout(db, existing.id);
    return existing.id;
  }
  const id = `${name.toLowerCase()}-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workstreams (id, name, description, directory, status, workstream_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 'standalone', ?, ?)`,
  ).run(id, name, description, directory, now, now);
  ensureLayout(db, id);
  console.log(`[seed] inserted workstream '${name}' id=${id}`);
  return id;
}

function ensureLayout(db, workstreamId) {
  // Mirror what create_workstream does in lib.rs — without this row,
  // update_layout (which uses UPDATE not UPSERT) silently no-ops and
  // tile_order_json never gets persisted.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO workstream_layouts (workstream_id, layout_mode, tile_order_json, updated_at)
     VALUES (?, 'adaptive', '[]', ?)`,
  ).run(workstreamId, now);
}

function ensureLoopSession(db, workstreamId) {
  fs.mkdirSync(path.join(SHOWCASE_SESSION_DIR, "files", "loops"), {
    recursive: true,
  });
  const workspace = path.join(SHOWCASE_SESSION_DIR, "workspace.yaml");
  if (!fs.existsSync(workspace)) {
    fs.writeFileSync(workspace, `id: ${SHOWCASE_SESSION_ID}\n`, "utf8");
  }
  ensureShowcaseFiles(
    SHOWCASE_DIR,
    path.join(SHOWCASE_SESSION_DIR, "files", "loops"),
  );
  const tileId = `showcase-loop-session-${workstreamId}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO tiles
       (id, workstream_id, tile_type, title, config_json, created_at, updated_at)
     VALUES (?, ?, 'copilot_session', 'Showcase loop session', ?, ?, ?)`,
  ).run(
    tileId,
    workstreamId,
    JSON.stringify({ copilot_session_id: SHOWCASE_SESSION_ID, pinned: true }),
    now,
    now,
  );
}

function main() {
  ensureShowcaseFiles();
  try {
    seedDb();
  } catch (err) {
    console.warn(`[seed] DB seeding skipped: ${err.message}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("dev-seed.mjs")) {
  main();
}

export { ensureShowcaseFiles, seedDb, dbHasWorkstreams, SAMPLE_MD, SHOWCASE_DIR, DB_PATH };
