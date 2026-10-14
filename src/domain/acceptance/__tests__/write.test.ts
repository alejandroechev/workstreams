import { describe, it, expect } from "vitest";
import { parseAcceptance } from "../parse";
import { setReview, addMissing, addVisualRequest } from "../write";
import type { WriteResult } from "../../grill/write";
import newFormat from "./fixtures/new-format.md?raw";
import oldFormat from "./fixtures/old-format.md?raw";

const ok = (result: WriteResult): string => {
  if (!result.ok) throw new Error(result.error);
  return result.text;
};
function changed(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Lines added or removed, as a multiset difference, in order of appearance.
  const removed = [...a];
  const added: string[] = [];
  for (const line of b) {
    const at = removed.indexOf(line);
    if (at >= 0) removed.splice(at, 1);
    else added.push(`+${line}`);
  }
  return [...removed.map((l) => `-${l}`), ...added];
}
const test = (text: string, id: string) => parseAcceptance(text).tests.find((t) => t.id === id)!;

describe("marking a test", () => {
  it("adds a mark under the test's header lines, changing nothing else", () => {
    const after = ok(setReview(newFormat, "AT-3", { kind: "change", note: "too vague" }));
    expect(changed(newFormat, after)).toEqual(["+**Review:** change: too vague"]);
    expect(test(after, "AT-3").review).toEqual({ kind: "change", note: "too vague" });
    const lines = after.split("\n");
    expect(lines[lines.indexOf("**Review:** change: too vague") - 1]).toBe("**Automation:** human-only");
  });

  it("puts a mark after a wrapped header field, not inside it", () => {
    const wrapped = "## AT-1 — T\n**Validates:** US-1\n**Automation:** agent-partial — UI is automated,\ncheck the colour manually\n**Given** a\n";
    const after = ok(setReview(wrapped, "AT-1", { kind: "ok" }));
    const parsed = parseAcceptance(after).tests[0];
    expect(parsed.review).toEqual({ kind: "ok" });
    expect(parsed.automation).toBe("agent-partial — UI is automated,\ncheck the colour manually");
    expect(parsed.given).toBe("a");
  });

  it("replaces an existing mark, and clears one", () => {
    const flipped = ok(setReview(newFormat, "AT-1", { kind: "change", note: "say which toast" }));
    expect(changed(newFormat, flipped)).toEqual(["-**Review:** ok", "+**Review:** change: say which toast"]);
    const cleared = ok(setReview(newFormat, "AT-2", null));
    expect(changed(newFormat, cleared)).toEqual(["-**Review:** change: also check the exit code"]);
    expect(test(cleared, "AT-2").review).toBeNull();
  });

  it("keeps a note on one line, so it can never change the file's structure", () => {
    const after = ok(setReview(newFormat, "AT-3", { kind: "change", note: "first\n## AT-9 — smuggled\n---" }));
    expect(test(after, "AT-3").review).toEqual({ kind: "change", note: "first ## AT-9 — smuggled ---" });
    expect(parseAcceptance(after).tests.map((t) => t.id)).toEqual(["AT-1", "AT-2", "AT-3"]);
  });

  it("needs a note to ask for a change", () => {
    expect(setReview(newFormat, "AT-3", { kind: "change", note: "  " })).toEqual({ ok: false, error: "Say what should change." });
  });

  it("refuses an unknown or repeated test id", () => {
    expect(setReview(newFormat, "AT-9", { kind: "ok" })).toEqual({ ok: false, error: "AT-9 is not in this file." });
    const doubled = newFormat.replace("## AT-3 — Untouched", "## AT-2 — Again");
    expect(setReview(doubled, "AT-2", { kind: "ok" })).toEqual({ ok: false, error: "This file has more than one AT-2; edit it directly." });
  });

  it("refuses to write an approved file", () => {
    const approved = newFormat.replace("status: draft", "status: approved");
    const refusal = { ok: false, error: "These tests are approved; the file is no longer changed from here." };
    expect(setReview(approved, "AT-1", { kind: "ok" })).toEqual(refusal);
    expect(addMissing(approved, "x")).toEqual(refusal);
    expect(addVisualRequest(approved, "AT-1", "x")).toEqual(refusal);
    expect(setReview(oldFormat, "AT-1", { kind: "ok" })).toEqual(refusal);
  });
});

describe("noting a missing test", () => {
  it("adds to the existing Missing tests section", () => {
    const after = ok(addMissing(newFormat, "nothing checks redo"));
    expect(changed(newFormat, after)).toEqual(["+- nothing checks redo"]);
    expect(parseAcceptance(after).missing).toEqual(["nothing checks undo", "nothing checks redo"]);
  });

  it("creates the section before Coverage when there is none", () => {
    const without = newFormat.replace("## Missing tests (review)\n- nothing checks undo\n\n", "");
    const after = ok(addMissing(without, "check the empty state"));
    expect(parseAcceptance(after).missing).toEqual(["check the empty state"]);
    expect(after.indexOf("## Missing tests")).toBeLessThan(after.indexOf("## Coverage"));
    expect(parseAcceptance(after).tests.map((t) => t.passesWhen)).toEqual(parseAcceptance(without).tests.map((t) => t.passesWhen));
  });

  it("appends the section at the end when there is no Coverage either", () => {
    const bare = "---\nstatus: draft\n---\n\n## AT-1 — x\n**Given** a\n";
    const after = ok(addMissing(bare, "more"));
    expect(after.startsWith(bare)).toBe(true);
    expect(parseAcceptance(after).missing).toEqual(["more"]);
  });

  it("needs a note", () => {
    expect(addMissing(newFormat, " ")).toEqual({ ok: false, error: "Say what is missing." });
  });
});

describe("requesting a visual", () => {
  it("goes before the Verify lines, with a default note", () => {
    const after = ok(addVisualRequest(newFormat, "AT-1", ""));
    expect(changed(newFormat, after)).toEqual(["+**Visual requested:** a storyboard for this test", "+"]);
    const lines = after.split("\n");
    expect(lines[lines.indexOf("**Visual requested:** a storyboard for this test") + 2]).toBe("**Verify (human):** Fill the form and press Save.");
    expect(test(after, "AT-1").visualRequests).toEqual(["a storyboard for this test"]);
  });

  it("goes before Passes when, or at the end of the test, when there is no Verify", () => {
    const after = ok(addVisualRequest(newFormat, "AT-3", "the screen"));
    expect(test(after, "AT-3").visualRequests).toEqual(["the screen"]);
    expect(test(after, "AT-3").passesWhen).toBe("z.");
    const tiny = "## AT-1 — x\n**Given** a\n\n---\n\n## AT-2 — y\n";
    const done = ok(addVisualRequest(tiny, "AT-1", "n"));
    expect(parseAcceptance(done).tests.map((t) => t.visualRequests)).toEqual([["n"], []]);
  });
});
