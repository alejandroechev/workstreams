import { describe, it, expect } from "vitest";
import { renderDevlogDay, GENERATED_BY_MARKER, isGeneratedByUs } from "../devlog-render";
import { makeTask, makeEvent } from "../tasks";
import type { Task, TaskEvent, Label } from "../tasks";
import type { Workstream } from "../types";

const LABELS: Label[] = [
  { id: "l1", name: "OfflineSDK", color: "#89b4fa" },
  { id: "l2", name: "Workstreams", color: "#cba6f7" },
  { id: "l3", name: "Bugs/Fixes", color: "#f38ba8" },
  { id: "l4", name: "FileComments", color: "#fab387" },
];

function ws(id: string, name: string): Workstream {
  return {
    id,
    name,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: null,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

const TODAY = "2026-08-19";
const at = (h: number, m = 0) => new Date(2026, 7, 19, h, m, 0).toISOString();

function render(tasks: Task[], events: TaskEvent[] = [], workstreams: Workstream[] = []) {
  return renderDevlogDay({ date: TODAY, tasks, events, labels: LABELS, workstreams });
}

describe("front matter", () => {
  it("stamps the date and a generated_by marker", () => {
    const out = render([]);
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("date: 2026-08-19");
    expect(out).toContain(GENERATED_BY_MARKER);
  });

  it("titles the page with the date", () => {
    expect(render([])).toContain("# 2026-08-19");
  });
});

describe("isGeneratedByUs", () => {
  it("recognises a page this renderer produced", () => {
    expect(isGeneratedByUs(render([]))).toBe(true);
  });

  it("rejects a hand-written page", () => {
    // A year of hand-written devlog sits in the same folder; misreading one as
    // ours would overwrite work that cannot be recovered.
    const handWritten = "## AudioTranscoding\n- 👁️Waiting on Marcus for bug fix review\n";
    expect(isGeneratedByUs(handWritten)).toBe(false);
  });

  it("rejects front matter that belongs to something else", () => {
    expect(isGeneratedByUs("---\ndate: 2026-08-19\ntags: [work]\n---\n# hi\n")).toBe(false);
  });

  it("rejects an empty file", () => {
    expect(isGeneratedByUs("")).toBe(false);
  });

  it("rejects a marker that merely contains ours", () => {
    // A substring test would authorise destroying every one of these.
    expect(isGeneratedByUs("---\nnot_generated_by: workstreams\n---\n")).toBe(false);
    expect(isGeneratedByUs("---\ngenerated_by: workstreams-backup\n---\n")).toBe(false);
    expect(isGeneratedByUs("---\n# generated_by: workstreams-ish\n---\n")).toBe(false);
  });

  it("tolerates CRLF and a byte-order mark, which editors add freely", () => {
    expect(isGeneratedByUs("---\r\ndate: x\r\ngenerated_by: workstreams\r\n---\r\n")).toBe(true);
    expect(isGeneratedByUs("\uFEFF---\ndate: x\ngenerated_by: workstreams\n---\n")).toBe(true);
  });
});

describe("sections", () => {
  it("derives a breadcrumb heading from the task's labels, in their stored order", () => {
    // The prototype round-trip lost section *ordering*, not content. Storing an
    // explicit label order on the task is what fixes it.
    const task = makeTask({
      id: "t1",
      title: "my reply to comments appear before agent replies",
      status: "done",
      labelIds: ["l2", "l3", "l4"],
      completedAt: at(11),
    });
    expect(render([task])).toContain("## Workstreams › Bugs/Fixes › FileComments");
  });

  it("groups tasks that share a label set under one heading", () => {
    const a = makeTask({ id: "a", title: "one", labelIds: ["l1"] });
    const b = makeTask({ id: "b", title: "two", labelIds: ["l1"] });
    const out = render([a, b]);
    expect(out.match(/^## OfflineSDK$/gm)).toHaveLength(1);
  });

  it("keeps a different label order as a distinct section rather than merging", () => {
    const a = makeTask({ id: "a", title: "one", labelIds: ["l2", "l3"] });
    const b = makeTask({ id: "b", title: "two", labelIds: ["l3", "l2"] });
    const out = render([a, b]);
    expect(out).toContain("## Workstreams › Bugs/Fixes");
    expect(out).toContain("## Bugs/Fixes › Workstreams");
  });

  it("files unlabelled work under its own heading rather than dropping it", () => {
    const out = render([makeTask({ id: "a", title: "unlabelled chore" })]);
    expect(out).toContain("## No label");
    expect(out).toContain("unlabelled chore");
  });
});

describe("task lines", () => {
  it("prefixes the status glyph already used in the archive", () => {
    const task = makeTask({ id: "a", title: "media_store read API", status: "in_progress", labelIds: ["l1"] });
    expect(render([task])).toContain("- ⚒️ **media_store read API**");
  });

  it("emits no glyph for a to-do, matching the plain bullets in the real files", () => {
    const task = makeTask({ id: "a", title: "Switch repo in a ws", labelIds: ["l1"] });
    expect(render([task])).toContain("- **Switch repo in a ws**");
    expect(render([task])).not.toContain("-  **Switch");
  });

  it("renders flags in front of the status, the way the archive stacks them", () => {
    const task = makeTask({
      id: "a",
      title: "offline sdk write path impl",
      status: "investigating",
      flags: ["priority"],
      labelIds: ["l1"],
    });
    expect(render([task])).toContain("- ‼️🕵️ **offline sdk write path impl**");
  });

  it("shows the linked workstream as an inline code ref", () => {
    const task = makeTask({ id: "a", title: "x", labelIds: ["l1"], workstreamId: "w1" });
    expect(render([task], [], [ws("w1", "offline-mock")])).toContain("`ws:offline-mock`");
  });

  it("omits the workstream ref entirely when there is none", () => {
    const task = makeTask({ id: "a", title: "x", labelIds: ["l1"] });
    expect(render([task])).not.toContain("`ws:");
  });

  it("marks the handful of tasks touched that day", () => {
    const a = makeTask({ id: "a", title: "touched", labelIds: ["l1"] });
    const b = makeTask({ id: "b", title: "untouched", labelIds: ["l1"] });
    const events = [makeEvent({ id: "e1", taskId: "a", kind: "note", text: "x", at: at(9) })];
    const out = render([a, b], events);
    expect(out).toMatch(/touched\*\*.*← touched today/);
    expect(out).not.toMatch(/untouched\*\*.*← touched today/);
  });
});

describe("subtasks and links", () => {
  it("nests subtasks with their own status glyphs", () => {
    const task = makeTask({
      id: "a",
      title: "offline sdk with mock storage",
      status: "in_progress",
      labelIds: ["l1"],
      subtasks: [
        { id: "s1", title: "Address first round of structural reviews", status: "done" },
        { id: "s2", title: "Addressing second round, manually", status: "in_progress" },
      ],
    });
    const out = render([task]);
    expect(out).toContain("  - ✅ Address first round of structural reviews");
    expect(out).toContain("  - ⚒️ Addressing second round, manually");
  });

  it("nests links under the task", () => {
    const task = makeTask({ id: "a", title: "x", labelIds: ["l1"], links: ["https://example/pr/1"] });
    expect(render([task])).toContain("  - https://example/pr/1");
  });
});

describe("notes", () => {
  const task = makeTask({ id: "a", title: "x", labelIds: ["l1"] });

  it("renders a manual note as a timestamped sub-bullet", () => {
    const events = [
      makeEvent({ id: "e1", taskId: "a", kind: "note", text: "picked this back up", at: at(14, 5), source: "manual" }),
    ];
    expect(render([task], events)).toContain("  - _14:05_ — picked this back up");
  });

  it("leaves auto events out of the page", () => {
    // Commit and board-move noise never appeared in the hand-written archive;
    // including it would bury the context the page exists to preserve.
    const events = [
      makeEvent({ id: "e1", taskId: "a", kind: "status", text: "→ in review", at: at(9), source: "auto" }),
      makeEvent({ id: "e2", taskId: "a", kind: "commit", text: "abc123", at: at(10), source: "auto" }),
    ];
    const out = render([task], events);
    expect(out).not.toContain("→ in review");
    expect(out).not.toContain("abc123");
  });

  it("includes only notes written on the day being rendered", () => {
    const events = [
      makeEvent({ id: "e1", taskId: "a", kind: "note", text: "today's note", at: at(9) }),
      makeEvent({
        id: "e2",
        taskId: "a",
        kind: "note",
        text: "yesterday's note",
        at: new Date(2026, 7, 18, 9, 0, 0).toISOString(),
      }),
    ];
    const out = render([task], events);
    expect(out).toContain("today's note");
    expect(out).not.toContain("yesterday's note");
  });

  it("orders notes chronologically", () => {
    const events = [
      makeEvent({ id: "e2", taskId: "a", kind: "note", text: "later", at: at(16) }),
      makeEvent({ id: "e1", taskId: "a", kind: "note", text: "earlier", at: at(9) }),
    ];
    const out = render([task], events);
    expect(out.indexOf("earlier")).toBeLessThan(out.indexOf("later"));
  });
});

describe("completed work", () => {
  it("includes a task on the day it finished", () => {
    const task = makeTask({
      id: "a",
      title: "finished today",
      status: "done",
      labelIds: ["l1"],
      completedAt: at(15),
    });
    expect(render([task])).toContain("✅ **finished today**");
  });

  it("drops it from every later day, which is the 76% that used to be copied", () => {
    const task = makeTask({
      id: "a",
      title: "finished yesterday",
      status: "done",
      labelIds: ["l1"],
      completedAt: new Date(2026, 7, 18, 15, 0, 0).toISOString(),
    });
    expect(render([task])).not.toContain("finished yesterday");
  });

  it("treats cancelled the same way, with its own glyph", () => {
    const task = makeTask({
      id: "a",
      title: "dropped today",
      status: "cancelled",
      labelIds: ["l1"],
      completedAt: at(15),
    });
    expect(render([task])).toContain("❌ **dropped today**");
  });

  it("keeps a terminal task with no timestamp rather than losing it silently", () => {
    const task = makeTask({ id: "a", title: "orphan", status: "done", labelIds: ["l1"], completedAt: null });
    expect(render([task])).toContain("orphan");
  });
});

describe("empty days", () => {
  it("still produces a valid page rather than an empty file", () => {
    const out = render([]);
    expect(isGeneratedByUs(out)).toBe(true);
    expect(out).toContain("# 2026-08-19");
  });

  it("ends with exactly one trailing newline", () => {
    const task = makeTask({ id: "a", title: "x", labelIds: ["l1"] });
    const out = render([task]);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});
