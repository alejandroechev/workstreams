import { editableRound, parseGrill, writableRounds, type Grill, type GrillQuestion, type Importance } from "./parse";

/**
 * Writers for grill-me.md (ADR 034). Each one changes exactly one slot of one
 * question in the round being answered and leaves every other byte alone, so
 * a round the agent appended meanwhile, or anything you typed elsewhere in the
 * file, is never disturbed. They take the file's current text and return the
 * new text: callers re-read the file right before writing.
 */

export const DEFAULT_ANSWER = "reco (default — not reviewed)";

export type WriteResult = { ok: true; text: string } | { ok: false; error: string };

function lines(text: string): string[] {
  return text.split("\n");
}

function locate(grill: Grill, round: number, id: string): { ok: true; question: GrillQuestion } | { ok: false; error: string } {
  if (!writableRounds(grill).includes(round)) return { ok: false, error: `Round ${round} is finished and read-only.` };
  const matches = grill.questions.filter((q) => q.round === round && q.id === id);
  if (matches.length === 0) return { ok: false, error: `Question ${id} is not in Round ${round}.` };
  if (matches.length > 1) return { ok: false, error: `Round ${round} has more than one ${id}; edit the file directly.` };
  return { ok: true, question: matches[0] };
}

const isReco = (answer: string) => /^reco\b/i.test(answer.trim());

export function setAnswer(text: string, round: number, id: string, answer: string): WriteResult {
  const found = locate(parseGrill(text), round, id);
  if (!found.ok) return found;
  const { question } = found;
  if (question.importance === "Blocking" && isReco(answer)) {
    return { ok: false, error: `${id} is Blocking: it needs your own answer, not the recommendation.` };
  }
  if (question.lines.answer === null || question.lines.answerEnd === null) {
    return { ok: false, error: `${id} has no **Answer:** line; edit the file directly.` };
  }
  const all = lines(text);
  const [first, ...rest] = answer.trim() === "" ? [""] : answer.replace(/\r\n/g, "\n").split("\n");
  const replacement = [first ? `**Answer:** ${first}` : "**Answer:**", ...rest];
  all.splice(question.lines.answer, question.lines.answerEnd - question.lines.answer, ...replacement);
  return { ok: true, text: all.join("\n") };
}

export function setImportance(text: string, round: number, id: string, level: Importance): WriteResult {
  const found = locate(parseGrill(text), round, id);
  if (!found.ok) return found;
  const { question } = found;
  const all = lines(text);
  const line = `**Importance:** ${level} (you)`;
  if (question.lines.importance !== null) all[question.lines.importance] = line;
  else all.splice(question.lines.heading + 1, 0, line);
  return { ok: true, text: all.join("\n") };
}

export function addVisualRequest(text: string, round: number, id: string, note: string): WriteResult {
  const found = locate(parseGrill(text), round, id);
  if (!found.ok) return found;
  const { question } = found;
  const at = question.lines.recommendation ?? question.lines.answer;
  if (at === null) return { ok: false, error: `${id} has no recommendation or answer line to place the request near.` };
  const all = lines(text);
  const request = `**Visual requested:** ${note.trim() || "a visual for this question"}`;
  all.splice(at, 0, request, "");
  return { ok: true, text: all.join("\n") };
}

export type FinishResult =
  | { ok: true; text: string; defaulted: string[] }
  | { ok: false; error: string; blocking?: string[] };

/**
 * Ends a round (by default the one being answered): every unanswered question records that it
 * takes the recommendation by default. Refused while a Blocking question is
 * unanswered. With `preview`, returns the summary without changing the text.
 */
export function finishRound(text: string, options: { preview?: boolean; round?: number } = {}): FinishResult {
  const grill = parseGrill(text);
  const round = options.round ?? editableRound(grill);
  if (!writableRounds(grill).includes(round)) return { ok: false, error: `Round ${round} is finished and read-only.` };
  const open = grill.questions.filter((q) => q.round === round && q.answer === "" && q.lines.answer !== null);
  const blocking = open.filter((q) => q.importance === "Blocking").map((q) => q.id);
  if (blocking.length > 0) return { ok: false, error: `Answer the Blocking questions first: ${blocking.join(", ")}.`, blocking };
  const defaulted = open.map((q) => q.id);
  if (options.preview) return { ok: true, text, defaulted };
  // Bottom-up, so earlier line numbers stay valid.
  const all = lines(text);
  for (const question of [...open].sort((a, b) => b.lines.answer! - a.lines.answer!)) {
    all.splice(question.lines.answer!, question.lines.answerEnd! - question.lines.answer!, `**Answer:** ${DEFAULT_ANSWER}`);
  }
  return { ok: true, text: all.join("\n"), defaulted };
}
