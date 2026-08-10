import { describe, it, expect } from "vitest";

import {
  TRACE_FORMAT_VERSION,
  parseTraceFile,
  isTraceFile,
  type TraceFile,
} from "../trace-format";

function validTrace(): TraceFile {
  return {
    version: 1,
    test: "pty::tests::default_shell_prefers_the_shell_env_var_on_unix",
    repoRoot: "/Users/me/repo",
    commitSha: "abc1234",
    recordedAt: "2026-08-10T13:00:00.000Z",
    truncated: false,
    steps: [
      { file: "src-tauri/src/pty.rs", line: 445, function: "tests::default_shell", hits: 2 },
      { file: "src-tauri/src/pty.rs", line: 153, function: "pty::resolve_unix_shell" },
    ],
  };
}

describe("trace-format", () => {
  it("exposes the current schema version", () => {
    expect(TRACE_FORMAT_VERSION).toBe(1);
  });

  describe("parseTraceFile", () => {
    it("accepts a well-formed trace and returns it typed", () => {
      const parsed = parseTraceFile(JSON.stringify(validTrace()));
      expect(parsed.test).toBe("pty::tests::default_shell_prefers_the_shell_env_var_on_unix");
      expect(parsed.steps).toHaveLength(2);
      expect(parsed.steps[0].line).toBe(445);
    });

    it("accepts an already-parsed object as well as a JSON string", () => {
      // The recorder hands us an object; the UI reads a file. Both paths must
      // go through the same validation rather than one trusting its input.
      const parsed = parseTraceFile(validTrace());
      expect(parsed.steps).toHaveLength(2);
    });

    it("rejects a future version with an actionable message", () => {
      // A trace written by a newer build must not be silently misread; the
      // whole point of versioning is that adding `vars` later is a non-event.
      const future = { ...validTrace(), version: 2 };
      expect(() => parseTraceFile(future)).toThrow(/version 2.*supports version 1/i);
    });

    it("rejects a missing or non-numeric version", () => {
      const noVersion = { ...validTrace() } as Record<string, unknown>;
      delete noVersion.version;
      expect(() => parseTraceFile(noVersion)).toThrow(/version/i);
      expect(() => parseTraceFile({ ...validTrace(), version: "1" })).toThrow(/version/i);
    });

    it("rejects malformed JSON with the underlying reason", () => {
      expect(() => parseTraceFile("{not json")).toThrow(/not valid json/i);
    });

    it("rejects a non-object payload", () => {
      expect(() => parseTraceFile("[]")).toThrow(/object/i);
      expect(() => parseTraceFile("null")).toThrow(/object/i);
      expect(() => parseTraceFile('"a string"')).toThrow(/object/i);
    });

    it("requires the identifying fields", () => {
      for (const field of ["test", "repoRoot", "commitSha", "recordedAt"] as const) {
        const broken = { ...validTrace() } as Record<string, unknown>;
        delete broken[field];
        expect(() => parseTraceFile(broken)).toThrow(new RegExp(field, "i"));
      }
    });

    it("requires steps to be an array", () => {
      expect(() => parseTraceFile({ ...validTrace(), steps: "nope" })).toThrow(/steps/i);
    });

    it("accepts an empty step list", () => {
      // A test that never enters repo code produces zero steps. That is a
      // legitimate (if useless) trace, not a corrupt file — the recorder
      // reports the emptiness, the parser shouldn't refuse to load it.
      const parsed = parseTraceFile({ ...validTrace(), steps: [] });
      expect(parsed.steps).toEqual([]);
    });

    it("rejects a step missing file or line", () => {
      expect(() => parseTraceFile({ ...validTrace(), steps: [{ line: 1, function: "f" }] }))
        .toThrow(/step 0.*file/i);
      expect(() => parseTraceFile({ ...validTrace(), steps: [{ file: "a.rs", function: "f" }] }))
        .toThrow(/step 0.*line/i);
    });

    it("rejects a non-positive or non-integer line number", () => {
      // Lines are 1-based in DAP; a 0 or 1.5 means the recorder malfunctioned.
      for (const line of [0, -3, 1.5]) {
        expect(() => parseTraceFile({ ...validTrace(), steps: [{ file: "a.rs", line, function: "f" }] }))
          .toThrow(/line/i);
      }
    });

    it("names the offending step index so a big trace is debuggable", () => {
      const steps = [
        { file: "a.rs", line: 1, function: "f" },
        { file: "b.rs", line: 2, function: "g" },
        { file: "c.rs", line: -1, function: "h" },
      ];
      expect(() => parseTraceFile({ ...validTrace(), steps })).toThrow(/step 2/i);
    });

    it("defaults an absent hits count to undefined rather than inventing 1", () => {
      const parsed = parseTraceFile(validTrace());
      expect(parsed.steps[0].hits).toBe(2);
      expect(parsed.steps[1].hits).toBeUndefined();
    });

    it("rejects a hits count below 2", () => {
      // `hits` only appears when a location was collapsed, so 1 is redundant
      // and 0 is nonsense. Rejecting keeps writers honest.
      expect(() => parseTraceFile({ ...validTrace(), steps: [{ file: "a.rs", line: 1, function: "f", hits: 1 }] }))
        .toThrow(/hits/i);
    });

    it("treats a missing vars field as 'not captured' rather than an error", () => {
      // v1 never records values (grill B5=a). The field is reserved so adding
      // it later needs no migration — absence must be legal, not a defect.
      const parsed = parseTraceFile(validTrace());
      expect("vars" in parsed.steps[0]).toBe(false);
    });

    it("defaults truncated to false when absent", () => {
      const noTruncated = { ...validTrace() } as Record<string, unknown>;
      delete noTruncated.truncated;
      expect(parseTraceFile(noTruncated).truncated).toBe(false);
    });

    it("preserves truncated: true so a capped trace is never mistaken for complete", () => {
      expect(parseTraceFile({ ...validTrace(), truncated: true }).truncated).toBe(true);
    });
  });

  describe("isTraceFile", () => {
    it("is true for a valid trace and false for anything else", () => {
      expect(isTraceFile(validTrace())).toBe(true);
      expect(isTraceFile({ version: 9 })).toBe(false);
      expect(isTraceFile(null)).toBe(false);
      expect(isTraceFile("{}")).toBe(false);
    });
  });
});
