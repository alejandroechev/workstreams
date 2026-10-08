import { describe, it, expect } from "vitest";
import { parseGrill, editableRound, type GrillQuestion } from "../parse";
import newFormat from "./fixtures/new-format.md?raw";
import oldFormat from "./fixtures/old-format.md?raw";
import twoRounds from "./fixtures/two-rounds.md?raw";

const q = (questions: GrillQuestion[], round: number, id: string) => questions.find((x) => x.round === round && x.id === id)!;

describe("parsing a grill", () => {
  const grill = parseGrill(newFormat);

  it("finds every question with its round and section, and nothing else", () => {
    expect(grill.questions.map((x) => `${x.round}:${x.id}`)).toEqual(["1:A1", "1:A2", "1:Z1", "2:A1", "2:A2", "2:A3"]);
    expect(grill.rounds).toEqual([{ number: 1, title: "Round 1" }, { number: 2, title: "Round 2 — follow-ups" }]);
    expect(q(grill.questions, 1, "A1")).toMatchObject({ title: "Where it lives", section: "A. Shape" });
  });

  it("reads importance, and whether you set it", () => {
    expect(grill.questions.map((x) => [x.importance, x.importanceByUser, x.importanceInferred])).toEqual([
      ["High", false, false], ["Low", true, false], ["Low", false, false],
      ["Blocking", false, false], ["Medium", false, false], ["Medium", false, true],
    ]);
  });

  it("reads options, the recommendation and the answer", () => {
    const a1 = q(grill.questions, 1, "A1");
    expect(a1.options).toEqual([
      { key: "a", text: "**Inside the app** as a tab" },
      { key: "b", text: "A separate window" },
      { key: "c", text: "A web page" },
    ]);
    expect(a1.recommendation).toBe("(a), it reuses what exists.");
    expect(a1.answer).toBe("a — only on the laptop");
    expect(q(grill.questions, 1, "A2").recommendation).toBe("(a).\nPlain files are easy to diff.");
    expect(q(grill.questions, 1, "A2").answer).toBe("");
    expect(q(grill.questions, 2, "A2").answer).toBe("line one\nline two");
    expect(q(grill.questions, 2, "A2").options).toEqual([]);
  });

  it("keeps the context, including mermaid and fenced blocks that look like markup", () => {
    const a2 = q(grill.questions, 1, "A2");
    expect(a2.context).toContain("Where does the state live?");
    expect(a2.context).toContain("```mermaid\ngraph LR\n  A --> B\n```");
    expect(a2.context).toContain("### not a heading");
    expect(a2.context).not.toContain("**Visual:**");
    expect(a2.context).not.toContain("**Importance:**");
    expect(a2.context).not.toContain("- (a) A file");
  });

  it("reads visuals, tied to an option or not, and visual requests", () => {
    expect(q(grill.questions, 1, "A2").visuals).toEqual([
      { path: "grill-assets/A2/today.png", label: "Today", option: null },
      { path: "grill-assets/A2/option-a.html", label: "Option a", option: "a" },
    ]);
    expect(q(grill.questions, 2, "A1").visualRequests).toEqual(["a prototype of option b"]);
  });

  it("edits only the latest round that still has unanswered questions", () => {
    expect(editableRound(grill)).toBe(2);
    expect(editableRound(parseGrill(newFormat.replace(/\*\*Answer:\*\*\n\n---\n\n### A3/, "**Answer:** x\n\n---\n\n### A3")))).toBe(2);
  });
});

describe("existing grills", () => {
  it("opens an old grill: every question Medium, options where (a)/(b) lines exist, otherwise none", () => {
    const grill = parseGrill(oldFormat);
    expect(grill.questions.length).toBeGreaterThan(10);
    expect(grill.questions.every((x) => x.importance === "Medium" && x.importanceInferred)).toBe(true);
    expect(grill.questions.some((x) => x.options.length >= 2)).toBe(true);
    expect(grill.questions.some((x) => x.options.length === 0)).toBe(true);
    expect(grill.questions.every((x) => x.recommendation.length > 0)).toBe(true);
    const a1 = grill.questions.find((x) => x.id === "A1")!;
    expect(a1.options.map((o) => o.key)).toEqual(["a", "b"]);
    expect(a1.answer).toBe("a)");
  });

  it("reads a two-round grill with ids repeated per round", () => {
    const grill = parseGrill(twoRounds);
    expect(grill.rounds.map((r) => r.number)).toEqual([1, 2]);
    const r2 = grill.questions.filter((x) => x.round === 2).map((x) => x.id);
    expect(r2).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
    expect(grill.questions.find((x) => x.round === 1 && x.id === "Z1")).toBeTruthy();
  });
});
