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

  it("agrees with the Rust twin on BOM and whitespace edge cases", () => {
    // Exactly the inputs where Rust's Unicode-aware trimming and JavaScript's
    // \s used to diverge. These assertions are duplicated verbatim in
    // src-tauri/src/devlog.rs; if the two ever disagree, the CLI and the UI
    // hold different opinions about which files may be destroyed.
    expect(isGeneratedByUs("\uFEFF\uFEFF---\ngenerated_by: workstreams\n---\n")).toBe(false);
    expect(isGeneratedByUs("---\ngenerated_by: workstreams\uFEFF\n---\n")).toBe(false);
    expect(isGeneratedByUs("---\ngenerated_by: workstreams\u00A0\n---\n")).toBe(false);
    expect(isGeneratedByUs("---\ngenerated_by: workstreams  \t\n---\n")).toBe(true);
  });

  it("tolerates CRLF and a byte-order mark, which editors add freely", () => {
    expect(isGeneratedByUs("---\r\ndate: x\r\ngenerated_by: workstreams\r\n---\r\n")).toBe(true);
    expect(isGeneratedByUs("\uFEFF---\ndate: x\ngenerated_by: workstreams\n---\n")).toBe(true);
  });
});


describe("task headings", () => {
  it("promotes each task to its own section, led by its status glyph", () => {
    const task = makeTask({
      id: "a",
      title: "Agency Code Review Telemetry",
      status: "in_progress",
      labelIds: ["l1"],
    });
    expect(render([task])).toContain("## ⚒️ Agency Code Review Telemetry");
  });

  it("emits no glyph for a to-do, matching the plain bullets in the archive", () => {
    const task = makeTask({ id: "a", title: "Switch repo in a ws", labelIds: ["l1"] });
    const out = render([task]);
    expect(out).toContain("## Switch repo in a ws");
    expect(out).not.toContain("##  Switch");
  });

  it("stacks flags in front of the status, the way the archive writes them", () => {
    const task = makeTask({
      id: "a",
      title: "offline sdk write path impl",
      status: "investigating",
      flags: ["priority"],
      labelIds: ["l1"],
    });
    expect(render([task])).toContain("## ‼️🕵️ offline sdk write path impl");
  });

  it("does not bold the title, which a heading already emphasises", () => {
    const task = makeTask({ id: "a", title: "plain", status: "done", completedAt: at(10) });
    expect(render([task])).not.toContain("**plain**");
  });

  it("keeps tasks sharing a label set adjacent, so grouping survives", () => {
    // The label headings are gone, so ordering is the only thing left holding
    // related work together on the page.
    const a = makeTask({ id: "a", title: "alpha", labelIds: ["l1"] });
    const b = makeTask({ id: "b", title: "beta", labelIds: ["l2"] });
    const c = makeTask({ id: "c", title: "gamma", labelIds: ["l1"] });
    const out = render([a, b, c]);
    expect(out.indexOf("## alpha")).toBeLessThan(out.indexOf("## gamma"));
    expect(out.indexOf("## gamma")).toBeLessThan(out.indexOf("## beta"));
  });
});

describe("task subsections", () => {
  const base = { id: "a", title: "Offline SDK Read Mock Storage", labelIds: ["l1"] };

  it("puts the linked workstream inline, with no heading of its own", () => {
    const task = makeTask({ ...base, workstreamId: "w1" });
    const out = render([task], [], [ws("w1", "Offline SDK")]);
    expect(out).toContain("`ws:Offline SDK`");
    expect(out).not.toContain("### Workstream");
  });

  it("lists subtasks with their own glyphs", () => {
    const task = makeTask({
      ...base,
      subtasks: [
        { id: "s1", title: "ACSMediaSDK Pipeline", status: "in_review" },
        { id: "s2", title: "Improve Dashboards", status: "done" },
        { id: "s3", title: "Backend Base", status: "todo" },
      ],
    });
    const out = render([task]);
    expect(out).toContain("### Subtasks");
    expect(out).toContain("- 👁️ ACSMediaSDK Pipeline");
    expect(out).toContain("- ✅ Improve Dashboards");
    expect(out).toContain("- Backend Base");
  });

  it("puts each label inline on its own line, with no heading", () => {
    const task = makeTask({ ...base, labelIds: ["l2", "l3"] });
    const out = render([task]);
    expect(out).toContain("`Workstreams`\n`Bugs/Fixes`");
    expect(out).not.toContain("### Labels");
  });

  it("puts labels above the workstream, directly under the task heading", () => {
    const task = makeTask({ ...base, status: "in_progress", labelIds: ["l1"], workstreamId: "w1" });
    const out = render([task], [], [ws("w1", "Offline SDK")]);
    expect(out).toContain(`## ⚒️ ${base.title}\n\n\`OfflineSDK\`\n\`ws:Offline SDK\`\n`);
  });

  it("emits nothing at all when a task has neither", () => {
    const out = render([makeTask({ ...base, status: "in_progress", labelIds: [] })]);
    expect(out).toContain(`## ⚒️ ${base.title}\n`);
    expect(out).not.toContain("`");
  });

  it("lists links under their own heading", () => {
    const task = makeTask({ ...base, links: ["https://example/pr/1"] });
    const out = render([task]);
    expect(out).toContain("### Links");
    expect(out).toContain("- https://example/pr/1");
  });

  it("omits every subsection a task has nothing for", () => {
    // At 60-odd open tasks, empty scaffolding would triple the page length.
    const out = render([makeTask({ ...base, labelIds: [] })]);
    for (const heading of ["### Subtasks", "### Notes", "### Links", "### Event log"]) {
      expect(out).not.toContain(heading);
    }
  });

  it("orders the subsections consistently", () => {
    const task = makeTask({
      ...base,
      workstreamId: "w1",
      labelIds: ["l1"],
      subtasks: [{ id: "s1", title: "sub", status: "todo" }],
      links: ["https://example/pr/1"],
      notes: "some context",
    });
    const out = render(
      [task],
      [makeEvent({ id: "e1", taskId: "a", kind: "note", text: "logged", at: at(14) })],
      [ws("w1", "Offline SDK")],
    );
    const order = ["### Subtasks", "### Links", "### Notes", "### Event log"];
    const positions = order.map((h) => out.indexOf(h));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(positions.every((p) => p > -1)).toBe(true);
  });
});

describe("notes", () => {
  const base = { id: "a", title: "task", labelIds: ["l1"] };

  it("emits the note verbatim rather than bulleting each line", () => {
    // Prefixing `- ` onto a line that already starts with `- ` produced the
    // `- - Moving the miner logic` double bullet in the old format.
    const task = makeTask({
      ...base,
      notes: "I am exploring some improvements:\n- Moving the miner logic to a shared repo\n- Adding tests",
    });
    const out = render([task]);
    expect(out).toContain("I am exploring some improvements:\n- Moving the miner logic to a shared repo\n- Adding tests");
    expect(out).not.toContain("- - Moving");
  });

  it("preserves blank lines between paragraphs", () => {
    // Notes are no longer nested inside a list, so a blank line is just a
    // paragraph break rather than something that terminates the list.
    const task = makeTask({ ...base, notes: "first para\n\nsecond para" });
    expect(render([task])).toContain("first para\n\nsecond para");
  });

  it("omits the section for a whitespace-only note", () => {
    expect(render([makeTask({ ...base, notes: "  \n\t\n" })])).not.toContain("### Notes");
  });

  it("trims trailing whitespace without touching the interior", () => {
    const out = render([makeTask({ ...base, notes: "  a note  \n" })]);
    expect(out).toContain("a note");
    expect(out).not.toContain("a note  ");
  });
});

describe("event log", () => {
  const task = makeTask({ id: "a", title: "task", labelIds: ["l1"] });

  it("lists the day's manual entries with their times", () => {
    const events = [
      makeEvent({ id: "e1", taskId: "a", kind: "note", text: "picked this back up", at: at(14, 5) }),
    ];
    const out = render([task], events);
    expect(out).toContain("### Event log");
    expect(out).toContain("- _14:05_ — picked this back up");
  });

  it("replaces the touched marker entirely", () => {
    // The presence of an event log is itself the signal that a task moved
    // that day, so a separate badge is redundant.
    const events = [makeEvent({ id: "e1", taskId: "a", kind: "note", text: "x", at: at(9) })];
    expect(render([task], events)).not.toContain("touched today");
  });

  it("leaves auto events out", () => {
    const events = [
      makeEvent({ id: "e1", taskId: "a", kind: "status", text: "→ in review", at: at(9), source: "auto" }),
    ];
    const out = render([task], events);
    expect(out).not.toContain("→ in review");
    expect(out).not.toContain("### Event log");
  });

  it("only includes entries from the day being exported", () => {
    // The export covers yesterday, so today's entries must not leak into it.
    const events = [
      makeEvent({ id: "e1", taskId: "a", kind: "note", text: "that day", at: at(9) }),
      makeEvent({
        id: "e2",
        taskId: "a",
        kind: "note",
        text: "the day after",
        at: new Date(2026, 7, 20, 9, 0).toISOString(),
      }),
    ];
    const out = render([task], events);
    expect(out).toContain("that day");
    expect(out).not.toContain("the day after");
  });

  it("orders entries chronologically", () => {
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
      title: "finished that day",
      status: "done",
      labelIds: ["l1"],
      completedAt: at(15),
    });
    expect(render([task])).toContain("## ✅ finished that day");
  });

  it("drops it from every later day", () => {
    const task = makeTask({
      id: "a",
      title: "finished earlier",
      status: "done",
      labelIds: ["l1"],
      completedAt: new Date(2026, 7, 18, 15, 0, 0).toISOString(),
    });
    expect(render([task])).not.toContain("finished earlier");
  });

  it("treats cancelled the same way, with its own glyph", () => {
    const task = makeTask({
      id: "a",
      title: "dropped",
      status: "cancelled",
      labelIds: ["l1"],
      completedAt: at(15),
    });
    expect(render([task])).toContain("## ❌ dropped");
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
    const out = render([makeTask({ id: "a", title: "x", labelIds: ["l1"] })]);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});
