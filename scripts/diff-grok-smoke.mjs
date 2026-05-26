#!/usr/bin/env node
/**
 * diff-grok CLI smoke test.
 *
 * Drives the skill loop end-to-end against a fixture diff using a pure
 * in-memory diff-review store that mirrors the eventual Tauri command
 * surface described in docs/adrs/007-diff-grok-integration.md.
 *
 * Run: `npm run diff-grok:smoke`
 *
 * Goals:
 *   - Exercise create_diff_review -> set_review_plan -> activate_chunk ->
 *     ack_chunk (+ add_comment) -> complete_review.
 *   - Walk 3 chunks: 1 trivial (auto-ack), 2 non-trivial (1 approved,
 *     1 commented).
 *   - Print a summary table; exit 0 on success.
 *
 * Why a local store: Phase 1 (Tauri-side commands) is implemented in
 * src-tauri/. This smoke runs from plain Node — no Tauri runtime, no
 * desktop app. The shape and event names below mirror the contract in
 * src/domain/diff-review.ts so the skill author can validate the loop
 * offline.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function id(prefix) {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}
function nowIso() {
  return new Date().toISOString();
}
function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory backend (workstream + diff-review).
// ---------------------------------------------------------------------------

class InMemoryDiffReviewBackend {
  constructor() {
    this.workstreams = new Map();
    this.reviews = new Map();
    this.chunks = new Map();
    this.hunks = new Map();
    this.comments = new Map();
    this.events = [];
  }

  // --- workstreams -----------------------------------------------------------
  createWorkstream(name, directory) {
    const ws = { id: id("ws"), name, directory, created_at: nowIso() };
    this.workstreams.set(ws.id, ws);
    return ws;
  }

  // --- diff reviews ----------------------------------------------------------
  create_diff_review({ workstream_id, diff_source, source_ref }) {
    if (!this.workstreams.has(workstream_id)) {
      throw new Error(`unknown workstream: ${workstream_id}`);
    }
    const review = {
      id: id("rev"),
      workstream_id,
      diff_source,
      source_ref: source_ref ?? null,
      status: "planning",
      plan_json: null,
      exported_path: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      completed_at: null,
    };
    this.reviews.set(review.id, review);
    return { review_id: review.id };
  }

  set_review_plan({ review_id, plan }) {
    const review = this._requireReview(review_id);
    review.plan_json = JSON.stringify(plan);
    review.status = "active";
    review.updated_at = nowIso();

    const totalHunks = (plan.chunks ?? []).reduce(
      (acc, c) => acc + (c.hunks?.length ?? 0),
      0,
    );

    plan.chunks.forEach((c, idx) => {
      const chunkId = id("ch");
      this.chunks.set(chunkId, {
        id: chunkId,
        review_id,
        ordinal: idx + 1,
        title: c.title,
        summary: c.summary ?? null,
        is_trivial: !!c.is_trivial,
        state: "pending",
        question_text: c.question_text || null,
        question_style: c.question_style ?? null,
        invalidated_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      (c.hunks ?? []).forEach((h) => {
        const hunkId = id("hk");
        this.hunks.set(hunkId, {
          id: hunkId,
          chunk_id: chunkId,
          file_path: h.file_path,
          old_start: h.old_start ?? null,
          old_lines: h.old_lines ?? null,
          new_start: h.new_start ?? null,
          new_lines: h.new_lines ?? null,
          patch_text: h.patch_text,
          content_hash: sha256(h.patch_text),
        });
      });
    });

    this._emit("diff-review:plan-ready", {
      reviewId: review_id,
      chunkCount: plan.chunks.length,
    });
    return { chunk_count: plan.chunks.length, hunk_count: totalHunks };
  }

  list_chunks({ review_id }) {
    this._requireReview(review_id);
    return Array.from(this.chunks.values())
      .filter((c) => c.review_id === review_id)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  get_chunk_details({ chunk_id }) {
    const chunk = this.chunks.get(chunk_id);
    if (!chunk) throw new Error(`unknown chunk: ${chunk_id}`);
    const hunks = Array.from(this.hunks.values()).filter(
      (h) => h.chunk_id === chunk_id,
    );
    const comments = Array.from(this.comments.values()).filter(
      (c) => c.chunk_id === chunk_id,
    );
    return { chunk, hunks, comments };
  }

  activate_chunk({ review_id, chunk_id }) {
    const chunk = this._requireChunk(review_id, chunk_id);
    if (chunk.state === "pending") {
      chunk.state = "seen";
      chunk.updated_at = nowIso();
    }
    this._emit("diff-review:chunk-active", {
      reviewId: review_id,
      chunkId: chunk_id,
      ordinal: chunk.ordinal,
    });
  }

  ack_chunk({ review_id, chunk_id, state }) {
    if (!["approved", "commented"].includes(state)) {
      throw new Error(`invalid ack state: ${state}`);
    }
    const chunk = this._requireChunk(review_id, chunk_id);
    chunk.state = state;
    chunk.updated_at = nowIso();
    this._emit("diff-review:chunk-done", {
      reviewId: review_id,
      chunkId: chunk_id,
      state,
    });
  }

  add_comment({ review_id, chunk_id, anchor_file, anchor_line_start, anchor_line_end, text }) {
    this._requireChunk(review_id, chunk_id);
    const comment = {
      id: id("cm"),
      chunk_id,
      anchor_file,
      anchor_line_start,
      anchor_line_end,
      text,
      created_at: nowIso(),
    };
    this.comments.set(comment.id, comment);
    this._emit("diff-review:comment-added", {
      reviewId: review_id,
      chunkId: chunk_id,
      commentId: comment.id,
    });
    return { comment_id: comment.id };
  }

  complete_review({ review_id, exportDir }) {
    const review = this._requireReview(review_id);
    const chunks = this.list_chunks({ review_id });
    const pendingNonTrivial = chunks.filter(
      (c) => !c.is_trivial && !["approved", "commented"].includes(c.state),
    );
    if (pendingNonTrivial.length > 0) {
      throw new Error(
        `cannot complete: ${pendingNonTrivial.length} non-trivial chunk(s) still pending`,
      );
    }

    const exportRoot = path.resolve(exportDir, review_id);
    mkdirSync(exportRoot, { recursive: true });

    const exportJson = {
      schema: 1,
      review_id,
      workstream_id: review.workstream_id,
      diff_source: review.diff_source,
      source_ref: review.source_ref,
      completed_at: nowIso(),
      chunks: chunks.map((c) => {
        const { hunks, comments } = this.get_chunk_details({ chunk_id: c.id });
        return {
          ordinal: c.ordinal,
          title: c.title,
          summary: c.summary,
          state: c.state,
          is_trivial: c.is_trivial,
          hunks: hunks.map((h) => ({
            file: h.file_path,
            old_start: h.old_start,
            new_start: h.new_start,
            patch: h.patch_text,
          })),
          comments: comments.map((cm) => ({
            anchor_file: cm.anchor_file,
            anchor_line_start: cm.anchor_line_start,
            anchor_line_end: cm.anchor_line_end,
            text: cm.text,
          })),
        };
      }),
    };

    const jsonPath = path.join(exportRoot, "review.json");
    const mdPath = path.join(exportRoot, "action-plan.md");
    writeFileSync(jsonPath, JSON.stringify(exportJson, null, 2));
    writeFileSync(mdPath, renderActionPlanMd(exportJson));

    review.status = "completed";
    review.exported_path = exportRoot;
    review.completed_at = exportJson.completed_at;
    review.updated_at = exportJson.completed_at;
    this._emit("diff-review:completed", {
      reviewId: review_id,
      exportedPath: exportRoot,
    });

    return { exported_path: exportRoot, json: jsonPath, markdown: mdPath };
  }

  // --- helpers ---------------------------------------------------------------
  _emit(event_type, payload) {
    this.events.push({ event_type, payload, at: nowIso() });
  }
  _requireReview(id) {
    const r = this.reviews.get(id);
    if (!r) throw new Error(`unknown review: ${id}`);
    return r;
  }
  _requireChunk(review_id, chunk_id) {
    const c = this.chunks.get(chunk_id);
    if (!c || c.review_id !== review_id) {
      throw new Error(`unknown chunk ${chunk_id} for review ${review_id}`);
    }
    return c;
  }
}

function renderActionPlanMd(exp) {
  const lines = [];
  lines.push(`# Diff Review Action Plan`);
  lines.push("");
  lines.push(`- review id: \`${exp.review_id}\``);
  lines.push(`- diff source: \`${exp.diff_source}\` (${exp.source_ref ?? "—"})`);
  lines.push(`- completed: ${exp.completed_at}`);
  lines.push("");
  exp.chunks.forEach((c) => {
    lines.push(`## ${c.ordinal}. ${c.title} _(state: ${c.state})_`);
    if (c.summary) lines.push(c.summary);
    if (c.comments.length === 0) {
      lines.push("- [x] No follow-up needed.");
    } else {
      c.comments.forEach((cm) => {
        lines.push(
          `- [ ] **${cm.anchor_file}** L${cm.anchor_line_start}-${cm.anchor_line_end}: ${cm.text}`,
        );
      });
    }
    lines.push("");
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fixture diff: 3 chunks (1 trivial, 2 non-trivial).
// ---------------------------------------------------------------------------

function buildFixturePlan() {
  return {
    chunks: [
      {
        title: "Bump @types/node to 20.11.0",
        summary: "Routine devDependency bump from 20.10.5 to 20.11.0.",
        is_trivial: true,
        question_style: "review",
        question_text: "",
        hunks: [
          {
            file_path: "package.json",
            old_start: 42,
            old_lines: 1,
            new_start: 42,
            new_lines: 1,
            patch_text:
              '@@ -42,1 +42,1 @@\n-    "@types/node": "20.10.5",\n+    "@types/node": "20.11.0",\n',
          },
        ],
      },
      {
        title: "Add retry budget to JWT verification",
        summary:
          "Wraps verifyJwt() in a 3-attempt retry with exponential backoff.",
        is_trivial: false,
        question_style: "socratic",
        question_text:
          "Why is the retry budget hardcoded to 3? What signal would tell you this is wrong?",
        hunks: [
          {
            file_path: "src/auth/mw.ts",
            old_start: 47,
            old_lines: 3,
            new_start: 47,
            new_lines: 9,
            patch_text:
              "@@ -47,3 +47,9 @@\n-    const claims = await verifyJwt(token);\n-    return claims;\n+    for (let attempt = 0; attempt < 3; attempt++) {\n+      try {\n+        return await verifyJwt(token);\n+      } catch (err) {\n+        await sleep(50 * 2 ** attempt);\n+      }\n+    }\n+    throw new Error('jwt verify exhausted');\n",
          },
        ],
      },
      {
        title: "Switch session store to in-memory in dev",
        summary:
          "Adds a factory that picks the in-memory session store when no DATABASE_URL is configured.",
        is_trivial: false,
        question_style: "guided",
        question_text:
          "Walk me through how this falls back when only DATABASE_URL_RO is set.",
        hunks: [
          {
            file_path: "src/session/store.ts",
            old_start: 1,
            old_lines: 5,
            new_start: 1,
            new_lines: 12,
            patch_text:
              "@@ -1,5 +1,12 @@\n-export function createStore(cfg) {\n-  return new PostgresStore(cfg.databaseUrl);\n-}\n+export function createStore(cfg) {\n+  if (!cfg.databaseUrl) {\n+    return new InMemoryStore();\n+  }\n+  return new PostgresStore(cfg.databaseUrl);\n+}\n+\n+export class InMemoryStore {\n+  constructor() { this.data = new Map(); }\n+}\n",
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Walkthrough driver — simulates what the skill does in Phase C.
// ---------------------------------------------------------------------------

async function walkthrough(backend, reviewId, simulator) {
  const chunks = backend.list_chunks({ review_id: reviewId });
  for (const chunk of chunks) {
    backend.activate_chunk({ review_id: reviewId, chunk_id: chunk.id });

    if (chunk.is_trivial) {
      console.log(
        `chunk ${chunk.ordinal}/${chunks.length}: ${chunk.title} — trivial, auto-acknowledged`,
      );
      backend.ack_chunk({
        review_id: reviewId,
        chunk_id: chunk.id,
        state: "approved",
      });
      continue;
    }

    console.log("");
    console.log(`━━━ chunk ${chunk.ordinal}/${chunks.length} ━━━`);
    console.log(chunk.title);
    if (chunk.summary) console.log(chunk.summary);
    console.log("");
    console.log(`Question (${chunk.question_style}):`);
    console.log(`  ${chunk.question_text}`);

    const decision = simulator(chunk);
    for (const c of decision.comments ?? []) {
      backend.add_comment({
        review_id: reviewId,
        chunk_id: chunk.id,
        anchor_file: c.anchor_file,
        anchor_line_start: c.anchor_line_start,
        anchor_line_end: c.anchor_line_end,
        text: c.text,
      });
    }
    backend.ack_chunk({
      review_id: reviewId,
      chunk_id: chunk.id,
      state: decision.ackState,
    });

    // Simulate the polling loop confirming the new state.
    const after = backend.get_chunk_details({ chunk_id: chunk.id });
    console.log(`  → user acked: ${after.chunk.state} (${after.comments.length} comment(s))`);
  }
}

// ---------------------------------------------------------------------------
// Summary table.
// ---------------------------------------------------------------------------

function printSummary(backend, reviewId) {
  const chunks = backend.list_chunks({ review_id: reviewId });
  const rows = chunks.map((c) => {
    const { comments } = backend.get_chunk_details({ chunk_id: c.id });
    return {
      "#": c.ordinal,
      title: truncate(c.title, 38),
      trivial: c.is_trivial ? "yes" : "no",
      state: c.state,
      comments: comments.length,
    };
  });
  console.log("");
  console.log("summary:");
  console.table(rows);
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const backend = new InMemoryDiffReviewBackend();

  // Phase A — workstream + review row.
  const ws = backend.createWorkstream("diff-grok-smoke", process.cwd());
  const { review_id } = backend.create_diff_review({
    workstream_id: ws.id,
    diff_source: "branch",
    source_ref: "master",
  });
  console.log(`created review ${review_id} for workstream ${ws.id}`);

  // Phase B — plan (3 chunks).
  const plan = buildFixturePlan();
  const { chunk_count, hunk_count } = backend.set_review_plan({
    review_id,
    plan,
  });
  console.log(`plan accepted: ${chunk_count} chunks, ${hunk_count} hunks`);

  // Phase C — walk: trivial auto-ack, chunk 2 approved no comment,
  // chunk 3 commented.
  await walkthrough(backend, review_id, (chunk) => {
    if (chunk.ordinal === 2) {
      return { ackState: "approved", comments: [] };
    }
    if (chunk.ordinal === 3) {
      return {
        ackState: "commented",
        comments: [
          {
            anchor_file: "src/session/store.ts",
            anchor_line_start: 4,
            anchor_line_end: 6,
            text: "Fallback should also handle DATABASE_URL=''.",
          },
        ],
      };
    }
    return { ackState: "approved", comments: [] };
  });

  // Phase D — complete + export.
  const exportDir = path.join(process.cwd(), ".dev", "diff-grok-smoke");
  const { exported_path, json, markdown } = backend.complete_review({
    review_id,
    exportDir,
  });
  console.log("");
  console.log("✅ review complete");
  console.log(`exported to: ${exported_path}`);
  console.log(`  ${json}`);
  console.log(`  ${markdown}`);

  printSummary(backend, review_id);

  // Validate expectations.
  const chunks = backend.list_chunks({ review_id });
  const errors = [];
  if (chunks.length !== 3) errors.push(`expected 3 chunks, got ${chunks.length}`);
  if (chunks[0].state !== "approved" || !chunks[0].is_trivial) {
    errors.push("chunk 1 should be trivial+approved");
  }
  if (chunks[1].state !== "approved") {
    errors.push(`chunk 2 should be approved, got ${chunks[1].state}`);
  }
  if (chunks[2].state !== "commented") {
    errors.push(`chunk 3 should be commented, got ${chunks[2].state}`);
  }
  const allComments = Array.from(backend.comments.values());
  if (allComments.length !== 1) {
    errors.push(`expected 1 comment total, got ${allComments.length}`);
  }
  const eventNames = backend.events.map((e) => e.event_type);
  for (const required of [
    "diff-review:plan-ready",
    "diff-review:chunk-active",
    "diff-review:chunk-done",
    "diff-review:comment-added",
    "diff-review:completed",
  ]) {
    if (!eventNames.includes(required)) {
      errors.push(`missing event: ${required}`);
    }
  }

  if (errors.length > 0) {
    console.error("");
    console.error("❌ smoke FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log("");
  console.log(`events emitted: ${backend.events.length}`);
  console.log("smoke OK");
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
