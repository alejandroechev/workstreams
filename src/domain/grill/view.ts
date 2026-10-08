import { IMPORTANCE_LEVELS, type Grill, type GrillOption, type GrillQuestion, type Importance } from "./parse";

/** Which questions the Answer view shows, and helpers it needs (ADR 034). */

export type Threshold = "All" | Importance;

export interface ViewFilter {
  /** Show questions at or above this level ("All" = every level). */
  threshold: Threshold;
  unansweredOnly: boolean;
}

export const IMPORTANCE_COLORS: Record<Importance, string> = {
  Low: "#6c7086",
  Medium: "#89b4fa",
  High: "#f9e2af",
  Blocking: "#f38ba8",
};

export function roundQuestions(grill: Grill, round: number): GrillQuestion[] {
  return grill.questions.filter((q) => q.round === round);
}

export function navigableQuestions(grill: Grill, round: number, filter: ViewFilter): GrillQuestion[] {
  const min = filter.threshold === "All" ? 0 : IMPORTANCE_LEVELS.indexOf(filter.threshold);
  return roundQuestions(grill, round).filter((q) =>
    IMPORTANCE_LEVELS.indexOf(q.importance) >= min && (!filter.unansweredOnly || q.answer === ""));
}

export function optionAnswer(key: string, note: string): string {
  return note.trim() ? `${key} — ${note.trim()}` : key;
}

/** The option an answer written by `optionAnswer` picked, or null for any other answer. */
export function selectedOption(answer: string, options: GrillOption[]): { key: string; note: string } | null {
  const match = /^([a-z])(?:\s+—\s+([\s\S]*))?$/.exec(answer.trim());
  if (!match || !options.some((o) => o.key === match[1])) return null;
  return { key: match[1], note: (match[2] ?? "").trim() };
}

/**
 * The absolute path of a visual, only if it lies inside the grill's own
 * `grill-assets/` folder. Anything else (absolute, parent segments, URLs,
 * backslashes) is refused.
 */
export function assetPath(grillDir: string, relative: string): string | null {
  if (!relative || relative.includes("\\") || relative.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(relative)) return null;
  const parts = relative.split("/");
  if (parts[0] !== "grill-assets" || parts.length < 2 || parts.some((p) => p === ".." || p === "." || p === "")) return null;
  return `${grillDir.replace(/\/+$/, "")}/${relative}`;
}

export const PROTOTYPE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * Prepares an agent-written HTML prototype for a sandboxed iframe (`srcdoc`,
 * `sandbox="allow-scripts"`, no same-origin): a Content-Security-Policy is put
 * first in the document, so nothing can load from the network, and images it names
 * from its own folder are inlined as data URLs. A policy in the page itself can
 * only add restrictions, never lift ours.
 */
export function prototypeDocument(html: string, images: Record<string, string>): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PROTOTYPE_CSP}">`;
  const doc = html.replace(/(\ssrc=)(["'])([^"']+)\2/gi, (whole, attr: string, quote: string, value: string) =>
    Object.prototype.hasOwnProperty.call(images, value) ? `${attr}${quote}${images[value]}${quote}` : whole);
  // First in the document, before any untrusted markup: the parser puts it in
  // the (implied) head, and the page's own doctype/html/head tags are ignored
  // or merged, so no comment or stray tag can hide it.
  return `<!doctype html>${meta}${doc}`;
}
