import { parseAcceptance, type AcceptanceFile, type AcceptanceTestBlock, type ReviewMark } from "./parse";
import type { WriteResult } from "../grill/write";

/**
 * One-slot writers for acceptance.md (ADR 037). Each changes one line (or adds
 * one) and leaves every other byte alone. All refuse once the file is
 * approved: from then on validate-acceptance pins its sha256, and a change
 * would read as an assertion edited after the fact.
 */

const APPROVED = "These tests are approved; the file is no longer changed from here.";

/** Notes go on one line, so a pasted heading or rule can never change the file's structure. */
const oneLine = (note: string) => note.replace(/\s+/g, " ").trim();

function open(text: string): { ok: true; file: AcceptanceFile; lines: string[] } | { ok: false; error: string } {
  const file = parseAcceptance(text);
  if (file.status === "approved") return { ok: false, error: APPROVED };
  return { ok: true, file, lines: text.split("\n") };
}

function locate(file: AcceptanceFile, id: string): { ok: true; test: AcceptanceTestBlock } | { ok: false; error: string } {
  const matches = file.tests.filter((t) => t.id === id);
  if (matches.length === 0) return { ok: false, error: `${id} is not in this file.` };
  if (matches.length > 1) return { ok: false, error: `This file has more than one ${id}; edit it directly.` };
  return { ok: true, test: matches[0] };
}

/** Sets (or, with null, clears) a test's review mark. */
export function setReview(text: string, id: string, mark: ReviewMark | null): WriteResult {
  const opened = open(text);
  if (!opened.ok) return opened;
  const found = locate(opened.file, id);
  if (!found.ok) return found;
  const { test } = found;
  const { lines } = opened;
  let line: string | null = null;
  if (mark?.kind === "ok") line = "**Review:** ok";
  if (mark?.kind === "change") {
    const note = oneLine(mark.note);
    if (!note) return { ok: false, error: "Say what should change." };
    line = `**Review:** change: ${note}`;
  }
  if (test.lines.review !== null) {
    if (line === null) lines.splice(test.lines.review, 1);
    else lines[test.lines.review] = line;
  } else if (line !== null) {
    lines.splice(test.lines.header + 1, 0, line);
  }
  return { ok: true, text: lines.join("\n") };
}

/** Records a test you expected that the file doesn't have. */
export function addMissing(text: string, note: string): WriteResult {
  const opened = open(text);
  if (!opened.ok) return opened;
  const item = oneLine(note);
  if (!item) return { ok: false, error: "Say what is missing." };
  const { file, lines } = opened;
  if (file.lines.missingEnd !== null) {
    lines.splice(file.lines.missingEnd, 0, `- ${item}`);
  } else if (file.lines.coverageHeading !== null) {
    lines.splice(file.lines.coverageHeading, 0, "## Missing tests (review)", `- ${item}`, "");
  } else {
    if (lines[lines.length - 1] === "") lines.pop();
    lines.push("", "## Missing tests (review)", `- ${item}`, "");
  }
  return { ok: true, text: lines.join("\n") };
}

/** Asks the agent for a storyboard (or another visual) on this test. */
export function addVisualRequest(text: string, id: string, note: string): WriteResult {
  const opened = open(text);
  if (!opened.ok) return opened;
  const found = locate(opened.file, id);
  if (!found.ok) return found;
  const { test } = found;
  const { lines } = opened;
  const request = `**Visual requested:** ${oneLine(note) || "a storyboard for this test"}`;
  if (test.lines.requestAt < test.lines.end) {
    lines.splice(test.lines.requestAt, 0, request, "");
  } else {
    lines.splice(test.lines.end, 0, "", request);
  }
  return { ok: true, text: lines.join("\n") };
}
