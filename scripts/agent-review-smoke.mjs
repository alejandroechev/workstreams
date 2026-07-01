#!/usr/bin/env node
/**
 * Agent Review CLI smoke test (ADR 013).
 *
 * Drives the reviewer↔agent loop end-to-end against a pure in-memory store
 * that mirrors the Tauri command surface + the MemoryBackend stub
 * (src/backend/memory-backend.ts) and the DTOs in src/domain/agent-review.ts.
 *
 * Run: `npm run agent-review:smoke`
 *
 * Walks the full loop:
 *   create review → reviewer comment → submit round (agent commits a fix, one
 *   comment's code changes) → agent replies + marks addressed → reviewer
 *   resolves → complete + export summary.
 *
 * Why a local store: this runs from plain Node — no Tauri runtime. The shape,
 * status transitions, and role guards mirror agent_review/mod.rs so the loop
 * can be validated offline. The git-driven re-anchor "changed" detection is a
 * simulated flag here; its real mechanics are validated in Rust
 * (.dev/anchor-probe, .dev/review-git-probe) and over MCP (.dev/mcp-review-smoke).
 */

import { randomBytes } from "node:crypto";

function id(p) {
  return `${p}-${randomBytes(4).toString("hex")}`;
}
function now() {
  return new Date().toISOString();
}

// ── In-memory backend (mirrors MemoryBackend agent-review semantics) ──
class AgentReviewStore {
  constructor() {
    this.reviews = new Map();
    this.comments = new Map();
  }
  createAgentReview(workstreamId) {
    for (const r of this.reviews.values()) {
      if (r.workstream_id === workstreamId && r.status === "active") return r;
    }
    const r = { id: id("rev"), workstream_id: workstreamId, base_ref: "master", head_ref: "HEAD", round: 1, status: "active", exported_path: null, completed_at: null, created_at: now(), updated_at: now() };
    this.reviews.set(r.id, r);
    return r;
  }
  addReviewComment(reviewId, path, start, end, body) {
    if (end < start) throw new Error("anchor_line_end must be >= anchor_line_start");
    const review = this.reviews.get(reviewId);
    const c = { id: id("c"), review_id: reviewId, workstream_id: review.workstream_id, absolute_path: path, anchor_line_start: start, anchor_line_end: end, anchor_text: null, body_md: body, author: "me", status: "open", origin_parent_id: null, round: review.round, anchor_state: "unchanged", fixing_commit: null, created_at: now(), updated_at: now() };
    this.comments.set(c.id, c);
    return c;
  }
  replyReviewComment(parentId, body, author) {
    if (author !== "me" && author !== "agent") throw new Error("author must be 'me' or 'agent'");
    const p = this.comments.get(parentId);
    const c = { id: id("c"), review_id: p.review_id, workstream_id: p.workstream_id, absolute_path: p.absolute_path, anchor_line_start: p.anchor_line_start, anchor_line_end: p.anchor_line_end, anchor_text: null, body_md: body, author, status: null, origin_parent_id: parentId, round: p.round, anchor_state: null, fixing_commit: null, created_at: now(), updated_at: now() };
    this.comments.set(c.id, c);
    return c;
  }
  setCommentResolution(commentId, status, actor) {
    const allowedMe = ["open", "addressed", "resolved", "wontfix"];
    const allowedAgent = ["addressed", "wontfix"];
    const ok = actor === "me" ? allowedMe.includes(status) : actor === "agent" ? allowedAgent.includes(status) : false;
    if (!ok) throw new Error(`actor '${actor}' may not set status '${status}'`);
    const c = this.comments.get(commentId);
    if (!c || c.origin_parent_id !== null) throw new Error("thread not found");
    c.status = status;
  }
  submitReviewRound(reviewId, simulateChanged = []) {
    const r = this.reviews.get(reviewId);
    r.round += 1;
    // The real backend re-anchors via git; here we mark the given comments as
    // "changed" to simulate the agent's fix touching that code.
    for (const cid of simulateChanged) {
      const c = this.comments.get(cid);
      if (c) { c.anchor_state = "changed"; c.fixing_commit = "abc1234 fix"; }
    }
  }
  list(reviewId) {
    return [...this.comments.values()].filter((c) => c.review_id === reviewId);
  }
  completeAgentReview(reviewId) {
    const roots = this.list(reviewId).filter((c) => c.origin_parent_id === null);
    const open = roots.filter((c) => (c.status ?? "open") !== "resolved" && (c.status ?? "open") !== "wontfix").length;
    if (open > 0) throw new Error(`${open} thread(s) still open`);
    const path = `session-state/reviews/${reviewId}/review.md`;
    const r = this.reviews.get(reviewId);
    r.status = "completed";
    r.exported_path = path;
    return path;
  }
}

let pass = 0, total = 0;
const check = (name, cond) => { total++; if (cond) pass++; console.log(`  ${cond ? "✅" : "❌"} ${name}`); };

const s = new AgentReviewStore();
console.log("── Agent Review loop ──────────────────────────────");

console.log("1. Reviewer opens a review");
const review = s.createAgentReview("ws-demo");
check("review created, round 1, active", review.round === 1 && review.status === "active");

console.log("2. Reviewer leaves a comment on auth.js:4");
const c = s.addReviewComment(review.id, "C:/repo/auth.js", 4, 4, "Don't log the decoded token — remove it.");
check("comment is open + author me", c.status === "open" && c.author === "me");

console.log("3. Reviewer rejects an inverted anchor");
let inverted = false;
try { s.addReviewComment(review.id, "C:/repo/auth.js", 8, 4, "bad"); } catch { inverted = true; }
check("inverted anchor rejected", inverted);

console.log("4. Agent commits a fix; reviewer submits round 2 (the fix touches the commented line)");
s.submitReviewRound(review.id, [c.id]);
const afterRound = s.comments.get(c.id);
check("round bumped to 2", s.reviews.get(review.id).round === 2);
check("comment flagged code-changed with a fixing commit", afterRound.anchor_state === "changed" && !!afterRound.fixing_commit);

console.log("5. Agent replies and marks it addressed (agent may NOT resolve)");
s.replyReviewComment(c.id, "Removed the console.log in abc1234.", "agent");
let agentResolveBlocked = false;
try { s.setCommentResolution(c.id, "resolved", "agent"); } catch { agentResolveBlocked = true; }
check("agent cannot 'resolve'", agentResolveBlocked);
s.setCommentResolution(c.id, "addressed", "agent");
check("agent set 'addressed'", s.comments.get(c.id).status === "addressed");

console.log("6. Review is not completable while a thread is unresolved");
let notComplete = false;
try { s.completeAgentReview(review.id); } catch { notComplete = true; }
check("complete blocked until reviewer resolves", notComplete);

console.log("7. Reviewer resolves and completes; a clean summary is exported");
s.setCommentResolution(c.id, "resolved", "me");
const path = s.completeAgentReview(review.id);
check("review completed + summary path returned", s.reviews.get(review.id).status === "completed" && path.includes("review.md"));

console.log(`\nExported summary: ${path}`);
console.log(`\nRESULT: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
