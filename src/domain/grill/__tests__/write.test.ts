import { describe, it, expect } from "vitest";
import { parseGrill } from "../parse";
import { setAnswer, setImportance, addVisualRequest, finishRound, DEFAULT_ANSWER, type WriteResult } from "../write";
import newFormat from "./fixtures/new-format.md?raw";
import oldFormat from "./fixtures/old-format.md?raw";

const ok = (result: WriteResult): string => {
  if (!result.ok) throw new Error(result.error);
  return result.text;
};
const answerOf = (text: string, round: number, id: string) =>
  parseGrill(text).questions.find((q) => q.round === round && q.id === id)!.answer;
/** Lines that differ between two texts, as [index, before, after]. */
function changedLines(before: string, after: string): Array<[number, string, string]> {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: Array<[number, string, string]> = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) out.push([i, a[i], b[i]]);
  return out;
}

describe("writing an answer", () => {
  it("fills an empty answer slot and changes nothing else", () => {
    const after = ok(setAnswer(newFormat, 2, "A1", "b — only on the phone"));
    expect(answerOf(after, 2, "A1")).toBe("b — only on the phone");
    expect(changedLines(newFormat, after)).toHaveLength(1);
  });

  it("replaces a multi-line answer, and can write one", () => {
    const after = ok(setAnswer(newFormat, 2, "A2", "first\nsecond\nthird"));
    expect(answerOf(after, 2, "A2")).toBe("first\nsecond\nthird");
    const again = ok(setAnswer(after, 2, "A2", "short"));
    expect(answerOf(again, 2, "A2")).toBe("short");
    expect(parseGrill(again).questions.map((q) => `${q.round}:${q.id}`)).toEqual(parseGrill(newFormat).questions.map((q) => `${q.round}:${q.id}`));
    expect(again.endsWith("Tell me **\"review\"**.\n")).toBe(true);
  });

  it("clears an answer", () => {
    const filled = ok(setAnswer(newFormat, 2, "A1", "a"));
    expect(ok(setAnswer(filled, 2, "A1", ""))).toBe(newFormat);
  });

  it("refuses to touch a finished earlier round", () => {
    const finished = ok(setAnswer(newFormat, 1, "A2", "x"));
    expect(setAnswer(finished, 1, "A1", "y")).toEqual({ ok: false, error: "Round 1 is finished and read-only." });
    expect(finishRound(finished, { round: 1 })).toEqual({ ok: false, error: "Round 1 is finished and read-only." });
    expect(setAnswer(newFormat, 2, "Q9", "x")).toEqual({ ok: false, error: "Question Q9 is not in Round 2." });
  });

  it("keeps an open round writable after the agent appends another", () => {
    const appended = `${newFormat}\n## Round 3\n\n### A1. Later\n\n**Answer:**\n`;
    const after = ok(setAnswer(appended, 2, "A2", "still mine"));
    expect(answerOf(after, 2, "A2")).toBe("still mine");
    expect(after.endsWith("## Round 3\n\n### A1. Later\n\n**Answer:**\n")).toBe(true);
    expect(finishRound(appended, { round: 3, preview: true })).toEqual({ ok: true, text: appended, defaulted: ["A1"] });
  });

  it("refuses an answer that would change the file's structure, writing nothing", () => {
    const error = "That answer would change the grill's structure (an unclosed ``` fence, a --- line or a heading). Close the fence or reword it; it is kept unsaved.";
    for (const unsafe of ["Example:\n```js\nconst x = 1;", "first\n---\nsecond", "x\n### B9. Smuggled", "x\n## Round 9"]) {
      expect(setAnswer(newFormat, 2, "A2", unsafe)).toEqual({ ok: false, error });
    }
  });

  it("refuses an unclosed fence even in the last answer of the file", () => {
    expect(setAnswer("### A1. Only\n**Answer:**\n", 1, "A1", "Example:\n```js\nlet x = 1;")).toMatchObject({ ok: false });
  });

  it("writes an answer that is only a code block, below the marker", () => {
    const code = "```js\nlet x = 1;\n```";
    const after = ok(setAnswer(newFormat, 2, "A2", code));
    expect(after).toContain("**Answer:**\n```js\nlet x = 1;\n```\n");
    expect(answerOf(after, 2, "A2")).toBe(code);
  });

  it("accepts a closed fence in an answer, round-tripping it", () => {
    const fenced = "Like this:\n```md\n### not a question\n---\n```\nok";
    const after = ok(setAnswer(newFormat, 2, "A2", fenced));
    expect(answerOf(after, 2, "A2")).toBe(fenced);
    expect(parseGrill(after).questions.map((q) => `${q.round}:${q.id}`)).toEqual(parseGrill(newFormat).questions.map((q) => `${q.round}:${q.id}`));
  });

  it("refuses reco on a Blocking question", () => {
    expect(setAnswer(newFormat, 2, "A1", "reco")).toEqual({ ok: false, error: "A1 is Blocking: it needs your own answer, not the recommendation." });
    expect(setAnswer(newFormat, 2, "A1", " Reco ")).toMatchObject({ ok: false });
  });

  it("refuses when the question is ambiguous", () => {
    const doubled = newFormat.replace("### A3. Untagged", "### A2. Duplicate");
    expect(setAnswer(doubled, 2, "A2", "x")).toEqual({ ok: false, error: "Round 2 has more than one A2; edit the file directly." });
  });

  it("works on an old grill without changing anything else", () => {
    const grill = parseGrill(oldFormat);
    const open = grill.questions.find((q) => q.answer === "");
    if (!open) return;
    const after = ok(setAnswer(oldFormat, open.round, open.id, "b"));
    expect(changedLines(oldFormat, after)).toHaveLength(1);
  });
});

describe("overriding importance", () => {
  it("replaces an importance line, marking it as yours", () => {
    const after = ok(setImportance(newFormat, 2, "A2", "High"));
    expect(after).toContain("**Importance:** High (you)");
    expect(changedLines(newFormat, after)).toHaveLength(1);
    expect(parseGrill(after).questions.find((q) => q.round === 2 && q.id === "A2")).toMatchObject({ importance: "High", importanceByUser: true });
  });

  it("adds one under the heading when the question has none", () => {
    const after = ok(setImportance(newFormat, 2, "A3", "Low"));
    const lines = after.split("\n");
    const at = lines.indexOf("### A3. Untagged");
    expect(lines[at + 1]).toBe("**Importance:** Low (you)");
    expect(changedLines(newFormat.split("\n").slice(0, at + 1).join("\n"), after.split("\n").slice(0, at + 1).join("\n"))).toEqual([]);
  });
});

describe("requesting a visual", () => {
  it("adds a request above the recommendation", () => {
    const after = ok(addVisualRequest(newFormat, 2, "A2", "  a diagram  "));
    const question = parseGrill(after).questions.find((q) => q.round === 2 && q.id === "A2")!;
    expect(question.visualRequests).toEqual(["a diagram"]);
    const lines = after.split("\n");
    expect(lines[question.lines.recommendation! - 2]).toBe("**Visual requested:** a diagram");
  });

  it("uses a default note when none is given", () => {
    const after = ok(addVisualRequest(newFormat, 2, "A3", ""));
    expect(after).toContain("**Visual requested:** a visual for this question");
  });
});

describe("finishing a round", () => {
  it("refuses while a Blocking question is unanswered, naming it", () => {
    expect(finishRound(newFormat)).toEqual({ ok: false, error: "Answer the Blocking questions first: A1.", blocking: ["A1"] });
  });

  it("records the default for every unanswered question of the round, and says how many", () => {
    const ready = ok(setAnswer(newFormat, 2, "A1", "b"));
    const result = finishRound(ready);
    if (!result.ok) throw new Error(result.error);
    expect(result.defaulted).toEqual(["A3"]);
    expect(answerOf(result.text, 2, "A3")).toBe(DEFAULT_ANSWER);
    expect(answerOf(result.text, 2, "A1")).toBe("b");
    expect(answerOf(result.text, 1, "A2")).toBe("");
    expect(DEFAULT_ANSWER).toBe("reco (default — not reviewed)");
  });

  it("refuses a round with a repeated question id", () => {
    const ready = newFormat.replace("**Importance:** Blocking", "**Importance:** High").replace("### A3. Untagged", "### A2. Duplicate");
    expect(finishRound(ready)).toEqual({ ok: false, error: "Round 2 has more than one A2; edit the file directly." });
  });

  it("previews without writing", () => {
    const ready = ok(setAnswer(newFormat, 2, "A1", "b"));
    expect(finishRound(ready, { preview: true })).toEqual({ ok: true, text: ready, defaulted: ["A3"] });
  });
});
