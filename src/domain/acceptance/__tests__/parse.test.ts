import { describe, it, expect } from "vitest";
import { parseAcceptance } from "../parse";
import newFormat from "./fixtures/new-format.md?raw";
import oldFormat from "./fixtures/old-format.md?raw";

describe("parsing an acceptance file", () => {
  const file = parseAcceptance(newFormat);

  it("reads the front-matter status and every test in file order", () => {
    expect(file.status).toBe("draft");
    expect(file.tests.map((t) => [t.id, t.title])).toEqual([
      ["AT-1", "Saving shows a toast"],
      ["AT-2", "The CLI prints the version"],
      ["AT-3", "Untouched"],
    ]);
  });

  it("reads each test's fields, multi-line ones included, ignoring fenced lines", () => {
    const [at1] = file.tests;
    expect(at1.validates).toBe("US-1, Round-1 A2");
    expect(at1.automation).toBe("agent");
    expect(at1.given).toBe("an open form\nwith two fields");
    expect(at1.when).toBe("you press Save");
    expect(at1.then).toBe('a toast says "Saved"');
    expect(at1.verifyHuman).toBe("Fill the form and press Save.");
    expect(at1.verifyAgent).toContain("**Then** inside a fence is not a field");
    expect(at1.verifyAgent).toContain("---");
    expect(at1.passesWhen).toBe("a toast with text Saved is visible.");
  });

  it("reads storyboard frames with their step and caption", () => {
    expect(file.tests[0].frames).toEqual([
      { path: "acceptance-assets/AT-1/1.html", caption: "The form", step: "given" },
      { path: "acceptance-assets/AT-1/2.png", caption: "Pressing Save", step: "when" },
      { path: "acceptance-assets/AT-1/3.html", caption: "The toast", step: "then" },
    ]);
  });

  it("reads review marks and visual requests", () => {
    expect(file.tests.map((t) => t.review)).toEqual([
      { kind: "ok" },
      { kind: "change", note: "also check the exit code" },
      null,
    ]);
    expect(file.tests[1].visualRequests).toEqual(["a flow of the CLI"]);
    expect(file.tests[2].verifyHuman).toBe("");
  });

  it("reads the missing-test notes", () => {
    expect(file.missing).toEqual(["nothing checks undo"]);
  });

  it("opens an older file: every test, no frames, no marks", () => {
    const old = parseAcceptance(oldFormat);
    expect(old.status).toBe("approved");
    expect(old.tests).toHaveLength(15);
    expect(old.tests.every((t) => t.frames.length === 0 && t.review === null)).toBe(true);
    expect(old.tests.every((t) => t.given !== "" && t.passesWhen !== "")).toBe(true);
    expect(old.tests[14].verifyAgent).toContain("git -C <workstreams> status --porcelain");
    expect(old.missing).toEqual([]);
  });

  it("treats a file without front-matter as a draft", () => {
    expect(parseAcceptance("## AT-1 — x\n**Given** a\n").status).toBe("draft");
    expect(parseAcceptance("").tests).toEqual([]);
  });
});
