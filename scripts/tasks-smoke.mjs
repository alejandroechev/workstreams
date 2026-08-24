#!/usr/bin/env node
/**
 * Project tracking — CLI smoke test (feature-parity rule).
 *
 * Drives the whole loop headlessly against a real temp SQLite DB and a real
 * temp "wiki" folder: create tasks, label them, subtask them, log notes, move
 * them on the board, then render and write a devlog page.
 *
 * Run: `npm run tasks:smoke`
 *
 * Why this exists beyond the unit tests:
 *
 *   1. **The clobber guard is the highest-risk code in the app.** The real
 *      target folder holds a year of hand-written work log. This exercises
 *      the guard against an actual hand-written file on disk, not a fixture.
 *   2. **Label dedupe is enforced in two places** -- the Rust `normalize_label`
 *      and the TypeScript `normalizeLabelName`. If they drift, the CLI mints a
 *      duplicate the UI would have refused. This asserts they agree.
 *   3. **Timestamps must be ISO-8601.** Epoch seconds in the same column is
 *      what broke file-comment ordering, and here it would put notes on the
 *      wrong devlog day.
 *
 * The schema is copied from `src-tauri/src/db.rs` so the smoke and the app
 * stay in lockstep.
 */

import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderDevlogDay, isGeneratedByUs } from "../src/domain/devlog-render.ts";
import { normalizeLabelName, resolveLabelNames } from "../src/domain/task-labels.ts";
import { makeTask, makeEvent, toLocalDate, previousLocalDate } from "../src/domain/tasks.ts";
import { parseStatusPrefix, statusEmoji } from "../src/domain/task-status.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#89b4fa',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS labels_name_unique ON labels (lower(trim(name)));
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  flags_json TEXT NOT NULL DEFAULT '[]',
  links_json TEXT NOT NULL DEFAULT '[]',
  workstream_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, label_id)
);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);
`;

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const workdir = mkdtempSync(path.join(tmpdir(), "ws-tasks-smoke-"));
const wiki = path.join(workdir, "fy2027");
const db = new Database(path.join(workdir, "tasks.db"));

mkdirSync(wiki, { recursive: true });

const nowIso = () =>
  db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS t").get().t;

try {
  db.exec(SCHEMA);

  // ── 1. Tasks, labels, dedupe ────────────────────────────────────────────
  console.log("\n1. Tasks and labels");

  const insertTask = db.prepare(
    "INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const ts = nowIso();
  insertTask.run("t1", "offline sdk with mock storage", "in_progress", ts, ts);
  insertTask.run("t2", "media_store read API", "todo", ts, ts);

  check("timestamps are ISO-8601, not epoch seconds", /^\d{4}-\d{2}-\d{2}T/.test(ts), ts);

  const insertLabel = db.prepare(
    "INSERT INTO labels (id, name, created_at) VALUES (?, ?, ?)",
  );
  insertLabel.run("l1", "OfflineSDK", ts);

  let dupeRejected = false;
  try {
    insertLabel.run("l2", " offlinesdk ", ts);
  } catch {
    dupeRejected = true;
  }
  check("the database itself rejects a case-variant label", dupeRejected);

  // The TypeScript resolver must reach the same verdict as the SQL index, or
  // the CLI and the UI disagree about what counts as a duplicate.
  const existing = db.prepare("SELECT id, name, color FROM labels").all();
  const resolved = resolveLabelNames(existing, ["offlinesdk"]);
  check(
    "the TypeScript resolver agrees with the SQL uniqueness rule",
    resolved.created.length === 0 && resolved.labelIds[0] === "l1",
    JSON.stringify(resolved),
  );
  check(
    "normalization collapses whitespace as well as case",
    normalizeLabelName("AI   Crew") === normalizeLabelName(" ai crew "),
  );

  db.prepare("INSERT INTO task_labels (task_id, label_id, position) VALUES (?, ?, 0)").run(
    "t1",
    "l1",
  );

  // ── 2. Subtasks and notes ───────────────────────────────────────────────
  console.log("\n2. Subtasks and the event log");

  db.prepare(
    "INSERT INTO subtasks (id, task_id, title, status, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("s1", "t1", "Address first round of structural reviews", "done", 0, ts, ts);

  const insertEvent = db.prepare(
    "INSERT INTO task_events (id, task_id, kind, text, source, created_at) VALUES (?,?,?,?,?,?)",
  );
  insertEvent.run("e1", "t1", "note", "picked this back up after the review", "manual", ts);
  insertEvent.run("e2", "t1", "status", "moved to in review", "auto", ts);
  // Long form lives in the log now, so an entry can span lines and carry its
  // own markdown list.
  insertEvent.run(
    "e3",
    "t1",
    "note",
    "Plan for now:\n- work on the feature branch\n- reuse existing read",
    "manual",
    ts,
  );

  check(
    "a subtask keeps its own status rather than a checkbox",
    db.prepare("SELECT status FROM subtasks WHERE id='s1'").get().status === "done",
  );

  // Free-form notes: multi-line, mutable, and distinct from the event log.
  db.prepare("UPDATE tasks SET notes = ? WHERE id = 't1'").run(
    "sync with Erwin to understand refactoring\ngather the precise requirements",
  );
  check(
    "notes survive storage with their newlines intact",
    db.prepare("SELECT notes FROM tasks WHERE id='t1'").get().notes.split("\n").length === 2,
  );
  db.prepare("UPDATE tasks SET notes = ? WHERE id = 't1'").run("revised understanding");
  check(
    "notes are mutable, unlike events",
    db.prepare("SELECT notes FROM tasks WHERE id='t1'").get().notes === "revised understanding",
  );
  // Deliberately contains its own markdown bullets: that is the shape that
  // produced the `- - Moving the miner logic` double bullet, and a note
  // without them cannot detect the regression at all.
  db.prepare("UPDATE tasks SET notes = ? WHERE id = 't1'").run(
    "sync with Erwin to understand refactoring\n\n- gather the precise requirements\n- design the read path",
  );

  // ── 3. Devlog rendering ─────────────────────────────────────────────────
  console.log("\n3. Devlog rendering");

  // The export covers the day just finished, not the one in progress.
  const today = previousLocalDate(new Date().toISOString());
  const rows = db.prepare("SELECT * FROM tasks ORDER BY position, created_at").all();
  const subs = db.prepare("SELECT * FROM subtasks").all();
  const evts = db.prepare("SELECT * FROM task_events").all();

  const tasks = rows.map((r) =>
    makeTask({
      id: r.id,
      title: r.title,
      notes: r.notes ?? "",
      status: r.status,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      labelIds: db
        .prepare("SELECT label_id FROM task_labels WHERE task_id = ?")
        .all(r.id)
        .map((x) => x.label_id),
      subtasks: subs
        .filter((s) => s.task_id === r.id)
        .map((s) => ({ id: s.id, title: s.title, status: s.status })),
    }),
  );

  const events = evts.map((e) =>
    makeEvent({
      id: e.id,
      taskId: e.task_id,
      kind: e.kind,
      text: e.text,
      at: new Date(`${today}T14:05:00`).toISOString(),
      source: e.source,
    }),
  );

  const labels = db.prepare("SELECT id, name, color FROM labels").all();
  const page = renderDevlogDay({ date: today, tasks, events, labels, workstreams: [] });

  check("the page carries the generated_by marker", isGeneratedByUs(page));
  check("open tasks appear", page.includes("offline sdk with mock storage"));
  check("each task owns a heading led by its status glyph", page.includes("## ⚒️ offline sdk with mock storage"));
  check(
    "labels sit inline under the heading, with no subheading of their own",
    page.includes("`OfflineSDK`") && !page.includes("### Labels") && !page.includes("### Workstream"),
  );
  check("subtasks sit under their own subheading", page.includes("### Subtasks") && page.includes("- ✅ Address first round"));
  check(
    "the day's log entries reach the page",
    page.includes("### Event log") && page.includes("picked this back up after the review"),
  );
  check(
    "free-form notes are emitted verbatim under their own subheading",
    page.includes("### Notes") &&
      page.includes("sync with Erwin to understand refactoring") &&
      page.includes("- gather the precise requirements"),
  );
  check(
    "a note that already contains bullets is never double-bulleted",
    !page.includes("- - "),
  );
  check(
    "a multi-line log entry keeps one timestamp and its own list",
    page.includes("- _14:05_ — Plan for now:") &&
      page.includes("  - work on the feature branch") &&
      !page.includes("- - work on the feature branch"),
  );
  check("auto events stay out of the page", !page.includes("moved to in review"));
  check(
    "the in-progress glyph matches the archive",
    page.includes(`## ${statusEmoji("in_progress")} offline sdk with mock storage`),
  );

  // The renderer and the parser must agree, or a page we generate could not be
  // read back consistently by anything downstream (including a human).
  const heading = page
    .split("\n")
    .find((l) => l.startsWith("## ") && l.includes("offline sdk"));
  const parsed = parseStatusPrefix(heading.slice(3));
  check("the parser reads back the status the renderer wrote", parsed.status === "in_progress");

  // ── 4. The clobber guard ────────────────────────────────────────────────
  console.log("\n4. The clobber guard");

  const dayFile = path.join(wiki, `${today}.md`);
  const HAND_WRITTEN =
    "## AudioTranscoding\n- 👁️Waiting on Marcus for bug fix review\n\t- ✅no repro\n";
  writeFileSync(dayFile, HAND_WRITTEN, "utf8");

  // Mirror of the Rust rule in src-tauri/src/devlog.rs: the provenance check
  // applies to EVERY candidate path, not just the intended one.
  const writable = (p) => !existsSync(p) || isGeneratedByUs(readFileSync(p, "utf8"));
  let target = "";
  if (writable(dayFile)) {
    target = dayFile;
  } else {
    for (let suffix = 0; suffix < 100 && !target; suffix++) {
      const candidate = path.join(
        wiki,
        suffix === 0 ? `${today}.workstreams.md` : `${today}.workstreams.${suffix}.md`,
      );
      if (writable(candidate)) target = candidate;
    }
  }
  writeFileSync(target, page, "utf8");

  check("a hand-written day is never chosen as the target", target !== dayFile);
  check(
    "the hand-written day is byte-for-byte untouched",
    readFileSync(dayFile, "utf8") === HAND_WRITTEN,
  );
  check("the export lands alongside it", existsSync(target));

  // A hand-written file at the ALONGSIDE name must be protected too, or
  // stepping aside just destroys a different file of the user's.
  const alongside = path.join(wiki, `${today}.workstreams.md`);
  writeFileSync(alongside, HAND_WRITTEN, "utf8");
  let secondTarget = "";
  for (let suffix = 0; suffix < 100 && !secondTarget; suffix++) {
    const candidate = path.join(
      wiki,
      suffix === 0 ? `${today}.workstreams.md` : `${today}.workstreams.${suffix}.md`,
    );
    if (writable(candidate)) secondTarget = candidate;
  }
  writeFileSync(secondTarget, page, "utf8");
  check(
    "a hand-written alongside file is protected as well",
    readFileSync(alongside, "utf8") === HAND_WRITTEN && secondTarget !== alongside,
  );

  // Exhaustion must refuse, exactly as the Rust and memory implementations do.
  // Writing to an empty path would fail with an unrelated filesystem error and
  // prove nothing about the contract.
  const exhaustDir = path.join(workdir, "exhausted");
  mkdirSync(exhaustDir, { recursive: true });
  const taken = [path.join(exhaustDir, `${today}.md`)];
  for (let i = 0; i < 100; i++) {
    taken.push(
      path.join(exhaustDir, i === 0 ? `${today}.workstreams.md` : `${today}.workstreams.${i}.md`),
    );
  }
  for (const f of taken) writeFileSync(f, HAND_WRITTEN, "utf8");

  let refused = false;
  let chosen = "";
  for (let suffix = 0; suffix < 100 && !chosen; suffix++) {
    const candidate = path.join(
      exhaustDir,
      suffix === 0 ? `${today}.workstreams.md` : `${today}.workstreams.${suffix}.md`,
    );
    if (writable(candidate)) chosen = candidate;
  }
  if (!chosen) refused = true;

  check("exhausting every fallback name refuses rather than writing", refused);
  check(
    "no hand-written file was touched while refusing",
    taken.every((f) => readFileSync(f, "utf8") === HAND_WRITTEN),
  );

  check(
    "a marker that merely contains ours is rejected",
    !isGeneratedByUs("---\nnot_generated_by: workstreams\n---\n"),
  );

  // A page we generated earlier IS replaceable, or regeneration would spawn a
  // new file every single day.
  const ourDay = path.join(wiki, "2026-01-02.md");
  writeFileSync(ourDay, page, "utf8");
  check(
    "a page we generated earlier is replaceable",
    isGeneratedByUs(readFileSync(ourDay, "utf8")),
  );

  // ── 5. Completed work leaves the page ───────────────────────────────────
  console.log("\n5. Completed work leaves the page");

  const finishedYesterday = makeTask({
    id: "t9",
    title: "finished yesterday",
    status: "done",
    labelIds: ["l1"],
    // Pinned one day before the page being rendered. A wall-clock offset here
    // was time-of-day dependent: after midday, "36 hours ago" lands on the
    // render date itself and the check silently stops testing anything.
    completedAt: new Date(`${previousLocalDate(`${today}T12:00:00`)}T15:00:00`).toISOString(),
  });
  const later = renderDevlogDay({
    date: today,
    tasks: [...tasks, finishedYesterday],
    events,
    labels,
    workstreams: [],
  });
  check(
    "yesterday's completion is gone — this is the 76% that used to be copied",
    !later.includes("finished yesterday"),
  );

  console.log(
    failures === 0
      ? "\n✅ tasks smoke passed\n"
      : `\n❌ tasks smoke failed (${failures} check${failures === 1 ? "" : "s"})\n`,
  );
} finally {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
