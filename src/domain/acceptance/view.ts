import type { AcceptanceTestBlock } from "./parse";

/** What Review mode needs besides the parsed file (ADR 037). */

export type Mark = "unmarked" | "ok" | "change";
export type MarkFilter = "all" | Mark;

export const MARK_COLORS: Record<Mark, string> = {
  unmarked: "#6c7086",
  ok: "#a6e3a1",
  change: "#f9e2af",
};

export const MARK_LABELS: Record<Mark, string> = {
  unmarked: "Not reviewed",
  ok: "Looks right",
  change: "Needs change",
};

export function markOf(test: AcceptanceTestBlock): Mark {
  return test.review?.kind ?? "unmarked";
}

export function filterByMark(tests: AcceptanceTestBlock[], filter: MarkFilter): AcceptanceTestBlock[] {
  return filter === "all" ? tests : tests.filter((t) => markOf(t) === filter);
}

/**
 * validate-acceptance saves a screenshot per storyboard frame as
 * `validation/r<n>/<AT-id>-<frame number>.png`, numbering frames from 1 in file order.
 */
export function screenshotName(testId: string, frameIndex: number): string {
  return `${testId}-${frameIndex + 1}.png`;
}

export interface ValidationRound { round: number; files: string[] }

/** For each frame, the latest round that saved its screenshot, or null. */
export function actualsFor(test: AcceptanceTestBlock, rounds: ValidationRound[]): Array<{ round: number; file: string } | null> {
  const newestFirst = [...rounds].sort((a, b) => b.round - a.round);
  return test.frames.map((_, index) => {
    const name = screenshotName(test.id, index);
    const round = newestFirst.find((r) => r.files.includes(name));
    return round ? { round: round.round, file: name } : null;
  });
}
