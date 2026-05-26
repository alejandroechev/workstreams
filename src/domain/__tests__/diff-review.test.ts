import { describe, expect, it } from "vitest";
import {
  DIFF_REVIEW_EVENTS,
  type DiffReviewExportV1,
} from "../diff-review";

describe("diff-review contracts", () => {
  it("event names are Tauri-safe (alphanumeric + - / : _)", () => {
    const safe = /^[a-zA-Z0-9\-/:_]+$/;
    for (const name of Object.values(DIFF_REVIEW_EVENTS)) {
      expect(name, `event "${name}" violates Tauri name rules`).toMatch(safe);
    }
  });

  it("event name catalog has the six expected entries", () => {
    expect(Object.keys(DIFF_REVIEW_EVENTS).sort()).toEqual([
      "CHUNK_ACTIVE",
      "CHUNK_DONE",
      "COMMENT_ADDED",
      "COMPLETED",
      "DRIFT_DETECTED",
      "PLAN_READY",
    ]);
  });

  it("sample export fixture matches v1 schema shape", () => {
    const sample: DiffReviewExportV1 = {
      schema: 1,
      review_id: "rev-2026-05-26-abc",
      workstream_id: "ws-test",
      diff_source: "branch",
      source_ref: "master",
      completed_at: "2026-05-26T15:00:00Z",
      chunks: [
        {
          ordinal: 1,
          title: "New logging in auth middleware",
          summary: "Adds debug-level logs around the JWT verification path",
          state: "commented",
          is_trivial: false,
          hunks: [
            {
              file: "src/auth/mw.ts",
              old_start: 42,
              new_start: 42,
              patch: "@@ -42,3 +42,5 @@\n   const t = req.headers.auth\n+  log.debug({ t }, 'verifying')\n",
            },
          ],
          comments: [
            {
              anchor_file: "src/auth/mw.ts",
              anchor_line_start: 47,
              anchor_line_end: 49,
              text: "Log level should be info, not debug — we want this in prod",
            },
          ],
        },
      ],
    };

    expect(sample.schema).toBe(1);
    expect(sample.chunks).toHaveLength(1);
    expect(sample.chunks[0].comments[0].text).toContain("Log level");
  });
});
