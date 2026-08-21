import { describe, it, expect } from "vitest";
import {
  BOARD_COLUMNS,
  TASK_STATUSES,
  columnForStatus,
  statusEmoji,
  statusFromEmoji,
  isTerminalStatus,
  TASK_FLAGS,
  flagEmoji,
  parseStatusPrefix,
} from "../task-status";

describe("BOARD_COLUMNS", () => {
  it("exposes exactly the columns the board renders, in order", () => {
    expect(BOARD_COLUMNS.map((c) => c.id)).toEqual([
      "todo",
      "in_progress",
      "in_review",
      "blocked",
      "parked",
      "delegated",
      "persistent",
      "done",
    ]);
  });
});

describe("columnForStatus", () => {
  it("maps each column-backed status to its own column", () => {
    for (const col of BOARD_COLUMNS) {
      expect(columnForStatus(col.id)).toBe(col.id);
    }
  });

  it("folds investigating into in_progress", () => {
    // Only 4 occurrences across 30 real devlog days -- a column that is empty
    // 99% of the time is pure cost, and investigating *is* in-progress work.
    expect(columnForStatus("investigating")).toBe("in_progress");
  });

  it("puts cancelled in the done column without making it done", () => {
    expect(columnForStatus("cancelled")).toBe("done");
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("in_progress")).toBe(false);
  });
});

describe("statusEmoji", () => {
  it("uses the glyphs already in daily use in the devlog", () => {
    expect(statusEmoji("in_progress")).toBe("⚒️");
    expect(statusEmoji("in_review")).toBe("👁️");
    expect(statusEmoji("blocked")).toBe("🧊");
    expect(statusEmoji("parked")).toBe("🚗");
    expect(statusEmoji("done")).toBe("✅");
    expect(statusEmoji("cancelled")).toBe("❌");
    expect(statusEmoji("investigating")).toBe("🕵️");
  });

  it("renders todo as no glyph, matching the plain bullets in the real files", () => {
    expect(statusEmoji("todo")).toBe("");
  });

  it("round-trips every status through its emoji", () => {
    for (const status of TASK_STATUSES) {
      if (status === "todo") continue;
      expect(statusFromEmoji(statusEmoji(status))).toBe(status);
    }
  });

  it("gives delegated a glyph that collides with no existing one", () => {
    const delegated = statusEmoji("delegated");
    expect(delegated).not.toBe("");
    const others = TASK_STATUSES.filter((s) => s !== "delegated" && s !== "todo").map(statusEmoji);
    expect(others).not.toContain(delegated);
  });
});

describe("statusFromEmoji", () => {
  it("returns null for a glyph that is not a status", () => {
    // The category bullets from the real files must never be read as statuses.
    expect(statusFromEmoji("🐞")).toBeNull();
    expect(statusFromEmoji("🌟")).toBeNull();
    expect(statusFromEmoji("")).toBeNull();
  });
});

describe("flags", () => {
  it("models priority and open-question as flags, not statuses", () => {
    expect(TASK_FLAGS.map((f) => f.id)).toEqual(["priority", "question"]);
    expect(TASK_STATUSES).not.toContain("priority" as never);
    expect(flagEmoji("priority")).toBe("‼️");
    expect(flagEmoji("question")).toBe("❓");
  });
});

describe("parseStatusPrefix", () => {
  it("reads a bare status glyph off the front of a line", () => {
    expect(parseStatusPrefix("⚒️offline sdk with mock storage")).toEqual({
      status: "in_progress",
      flags: [],
      text: "offline sdk with mock storage",
    });
  });

  it("reads a priority flag stacked in front of a status glyph", () => {
    // `‼️🕵️offline sdk write path impl` is real. A flag stacking on top of a
    // status is the proof that priority cannot itself be a status.
    expect(parseStatusPrefix("‼️🕵️offline sdk write path impl")).toEqual({
      status: "investigating",
      flags: ["priority"],
      text: "offline sdk write path impl",
    });
  });

  it("defaults to todo when there is no glyph at all", () => {
    expect(parseStatusPrefix("Switch repo in a ws")).toEqual({
      status: "todo",
      flags: [],
      text: "Switch repo in a ws",
    });
  });

  it("tolerates whitespace between the glyph and the text", () => {
    expect(parseStatusPrefix("🚗 I have a agency task for you!")).toEqual({
      status: "parked",
      flags: [],
      text: "I have a agency task for you!",
    });
  });

  it("does not treat a category glyph as a status", () => {
    expect(parseStatusPrefix("🐞Bugs/Fixes")).toEqual({
      status: "todo",
      flags: [],
      text: "🐞Bugs/Fixes",
    });
  });
});

describe("persistent status", () => {
  it("gets its own column, since ongoing work never flows to Done", () => {
    expect(BOARD_COLUMNS.map((c) => c.id)).toContain("persistent");
    expect(columnForStatus("persistent")).toBe("persistent");
  });

  it("sits with the other non-flowing buckets, before Done", () => {
    const ids = BOARD_COLUMNS.map((c) => c.id);
    expect(ids.indexOf("persistent")).toBeGreaterThan(ids.indexOf("delegated"));
    expect(ids.indexOf("persistent")).toBeLessThan(ids.indexOf("done"));
  });

  it("is never terminal — that is the whole point of it", () => {
    expect(isTerminalStatus("persistent")).toBe(false);
  });

  it("has a glyph that collides with no other", () => {
    const glyph = statusEmoji("persistent");
    expect(glyph).not.toBe("");
    const others = TASK_STATUSES.filter((s) => s !== "persistent" && s !== "todo").map(statusEmoji);
    expect(others).not.toContain(glyph);
  });

  it("round-trips through its glyph", () => {
    expect(statusFromEmoji(statusEmoji("persistent"))).toBe("persistent");
  });

  it("parses off the front of a line like any other status", () => {
    expect(parseStatusPrefix(`${statusEmoji("persistent")}workstreams development`)).toEqual({
      status: "persistent",
      flags: [],
      text: "workstreams development",
    });
  });
});
