/**
 * Reads a grill-me.md into rounds and questions (ADR 034). The file is the
 * source of truth; this only reads it. Writers that change one slot live in
 * `write.ts` and use the line ranges recorded here.
 *
 * Format (new grills; old grills degrade gracefully):
 *
 *   ### B2. Title
 *   **Importance:** High            (or "High (you)"; missing → Medium)
 *   context markdown, mermaid fences…
 *   - (a) option text               ("(a) text" also accepted)
 *   **Visual:** grill-assets/B2/x.html "Label" (a)
 *   **Visual requested:** note
 *   **Recommendation:** …
 *   **Answer:** …
 *
 * Rounds: everything before the first `## Round N` is round 1.
 */

export type Importance = "Low" | "Medium" | "High" | "Blocking";
export const IMPORTANCE_LEVELS: Importance[] = ["Low", "Medium", "High", "Blocking"];

export interface GrillOption { key: string; text: string }
export interface GrillVisual { path: string; label: string; option: string | null }

export interface GrillQuestion {
  round: number;
  id: string;
  title: string;
  section: string;
  importance: Importance;
  importanceByUser: boolean;
  /** No importance marker: an older grill. */
  importanceInferred: boolean;
  context: string;
  options: GrillOption[];
  visuals: GrillVisual[];
  visualRequests: string[];
  recommendation: string;
  /** The answer text; "" when unanswered. */
  answer: string;
  /** Line ranges (0-based, end exclusive) in the file. */
  lines: {
    heading: number;
    end: number;
    importance: number | null;
    recommendation: number | null;
    answer: number | null;
    /** End of the answer's text (exclusive); trailing blank lines are not part of it. */
    answerEnd: number | null;
  };
}

export interface GrillRound { number: number; title: string }

export interface Grill {
  rounds: GrillRound[];
  questions: GrillQuestion[];
}

const QUESTION = /^###\s+([A-Z]\d+)\.\s*(.*)$/;
const SECTION = /^##\s+(?!#)(.*)$/;
const ROUND = /^##\s+Round\s+(\d+)\b(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const IMPORTANCE = /^\*\*Importance:\*\*\s*(Low|Medium|High|Blocking)\s*(\(you\))?\s*$/i;
const OPTION = /^\s*(?:[-*]\s+)?\(([a-z])\)\s+(.*)$/;
const VISUAL = /^\*\*Visual:\*\*\s+(\S+)(?:\s+"([^"]*)")?(?:\s+\(([a-z])\))?\s*$/;
const VISUAL_REQUESTED = /^\*\*Visual requested:\*\*\s*(.*)$/;
const RECOMMENDATION = /^\*\*Recommendation:\*\*\s?(.*)$/;
const ANSWER = /^\*\*Answer:\*\*\s?(.*)$/;
/** A line that ends a question: a horizontal rule or any heading. */
const END = /^(---+\s*$|#{1,3}\s)/;

function normaliseImportance(text: string): Importance {
  const lower = text.toLowerCase();
  return IMPORTANCE_LEVELS.find((level) => level.toLowerCase() === lower) ?? "Medium";
}

/** Which lines are inside a fenced code block (where nothing is markup). */
function fencedLines(lines: string[]): boolean[] {
  const inside: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (open) {
      inside.push(true);
      if (match && match[1] === open) open = null;
    } else if (match) {
      open = match[1];
      inside.push(true);
    } else {
      inside.push(false);
    }
  }
  return inside;
}

export function parseGrill(text: string): Grill {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fenced = fencedLines(lines);
  const rounds: GrillRound[] = [{ number: 1, title: "Round 1" }];
  const questions: GrillQuestion[] = [];
  let round = 1;
  let section = "";

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fenced[i]) { i += 1; continue; }
    const roundMatch = ROUND.exec(line);
    if (roundMatch) {
      round = Number(roundMatch[1]);
      if (!rounds.some((r) => r.number === round)) rounds.push({ number: round, title: line.replace(/^##\s+/, "").trim() });
      section = "";
      i += 1;
      continue;
    }
    const sectionMatch = SECTION.exec(line);
    if (sectionMatch) { section = sectionMatch[1].trim(); i += 1; continue; }
    const questionMatch = QUESTION.exec(line);
    if (!questionMatch) { i += 1; continue; }

    // The question runs to the next rule or heading outside a fence.
    let end = i + 1;
    while (end < lines.length && (fenced[end] || !END.test(lines[end]))) end += 1;
    questions.push(parseQuestion(lines, fenced, i, end, round, section, questionMatch[1], questionMatch[2].trim()));
    i = end;
  }
  return { rounds, questions };
}

function parseQuestion(
  lines: string[],
  fenced: boolean[],
  heading: number,
  end: number,
  round: number,
  section: string,
  id: string,
  title: string,
): GrillQuestion {
  let importance: Importance = "Medium";
  let importanceByUser = false;
  let importanceLine: number | null = null;
  const options: GrillOption[] = [];
  const visuals: GrillVisual[] = [];
  const visualRequests: string[] = [];
  const context: string[] = [];
  let recommendationLine: number | null = null;
  let answerLine: number | null = null;

  for (let i = heading + 1; i < end; i += 1) {
    const line = lines[i];
    if (fenced[i]) { if (recommendationLine === null && answerLine === null) context.push(line); continue; }
    if (answerLine !== null) continue;
    if (recommendationLine !== null) {
      if (ANSWER.test(line)) answerLine = i;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = IMPORTANCE.exec(line)) && importanceLine === null) {
      importance = normaliseImportance(m[1]);
      importanceByUser = Boolean(m[2]);
      importanceLine = i;
    } else if ((m = VISUAL.exec(line))) {
      visuals.push({ path: m[1], label: m[2] ?? m[1].split("/").pop() ?? m[1], option: m[3] ?? null });
    } else if ((m = VISUAL_REQUESTED.exec(line))) {
      visualRequests.push(m[1].trim());
    } else if ((m = OPTION.exec(line))) {
      options.push({ key: m[1], text: m[2].trim() });
    } else if (RECOMMENDATION.test(line)) {
      recommendationLine = i;
    } else if (ANSWER.test(line)) {
      answerLine = i;
    } else {
      context.push(line);
    }
  }

  const recommendation = recommendationLine === null
    ? ""
    : collect(lines, recommendationLine, answerLine ?? end, RECOMMENDATION);
  let answer = "";
  let answerEnd: number | null = null;
  if (answerLine !== null) {
    answerEnd = end;
    while (answerEnd > answerLine + 1 && lines[answerEnd - 1].trim() === "") answerEnd -= 1;
    answer = collect(lines, answerLine, answerEnd, ANSWER);
  }

  return {
    round,
    id,
    title,
    section,
    importance,
    importanceByUser,
    importanceInferred: importanceLine === null,
    context: context.join("\n").trim(),
    options,
    visuals,
    visualRequests,
    recommendation,
    answer,
    lines: { heading, end, importance: importanceLine, recommendation: recommendationLine, answer: answerLine, answerEnd },
  };
}

/** The text of a `**Label:** …` field: the rest of its line plus the lines after it. */
function collect(lines: string[], start: number, end: number, label: RegExp): string {
  const first = label.exec(lines[start])?.[1] ?? "";
  return [first, ...lines.slice(start + 1, end)].join("\n").trim();
}

/** The round the UI may write to: the latest one with an unanswered question, else the latest. */
export function editableRound(grill: Grill): number {
  const open = grill.questions.filter((q) => q.answer === "" && q.lines.answer !== null).map((q) => q.round);
  if (open.length > 0) return Math.max(...open);
  return Math.max(...grill.rounds.map((r) => r.number));
}
