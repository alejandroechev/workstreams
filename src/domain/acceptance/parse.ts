import { fencedLines } from "../grill/parse";

/**
 * Parser for a feature's acceptance.md (ADR 037). Tests are `## AT-n — title`
 * blocks whose parts are found by their bold labels (`**Given**`,
 * `**Passes when:**`, …); fenced code is never read as a label. Storyboard
 * frames, review marks and visual requests are marker lines in the same style
 * as grills. Older files simply have none of those.
 */

export type AcceptanceStatus = "draft" | "approved";
export type FrameStep = "given" | "when" | "then";
export type ReviewMark = { kind: "ok" } | { kind: "change"; note: string };

export interface StoryFrame {
  path: string;
  caption: string;
  step: FrameStep | null;
}

export interface AcceptanceTestBlock {
  id: string;
  title: string;
  validates: string;
  automation: string;
  given: string;
  when: string;
  then: string;
  verifyHuman: string;
  verifyAgent: string;
  passesWhen: string;
  frames: StoryFrame[];
  review: ReviewMark | null;
  visualRequests: string[];
  /** Line numbers (0-based) the writers need. `end` is exclusive and stops before a trailing `---`. */
  lines: {
    heading: number;
    end: number;
    review: number | null;
    /** The last of the Validates/Automation lines under the heading, where a review mark goes. */
    header: number;
    /** Where a visual request goes: before the first Verify/Passes/Status line, else `end`. */
    requestAt: number;
  };
}

export interface AcceptanceFile {
  status: AcceptanceStatus;
  tests: AcceptanceTestBlock[];
  /** Notes from the "Missing tests" section: tests you asked for that don't exist yet. */
  missing: string[];
  lines: { missingHeading: number | null; missingEnd: number | null; coverageHeading: number | null };
}

const TEST_HEADING = /^##\s+(AT-\d+)\s*[—–-]+\s*(.*)$/;
const ANY_HEADING = /^#{1,2}\s/;
const MISSING_HEADING = /^##\s+Missing tests\b/i;
const COVERAGE_HEADING = /^##\s+Coverage\b/i;
const FIELD = /^\*\*([A-Za-z][^*]*?):?\*\*:?\s?(.*)$/;
const RULE = /^---+\s*$/;
const FRAME = /^(\S+)(?:\s+"([^"]*)")?(?:\s+\((given|when|then)\))?\s*$/i;

type FieldName =
  | "validates" | "automation" | "given" | "when" | "then" | "verifyHuman" | "verifyAgent"
  | "passesWhen" | "status" | "frame" | "review" | "visualRequested";

const FIELD_NAMES: Record<string, FieldName> = {
  validates: "validates",
  automation: "automation",
  given: "given",
  when: "when",
  then: "then",
  "verify (human)": "verifyHuman",
  "verify (agent)": "verifyAgent",
  "passes when": "passesWhen",
  status: "status",
  frame: "frame",
  review: "review",
  "visual requested": "visualRequested",
};

function frontMatterStatus(lines: string[]): AcceptanceStatus {
  if (lines[0]?.trim() !== "---") return "draft";
  for (let i = 1; i < lines.length && lines[i].trim() !== "---"; i += 1) {
    const match = /^status:\s*(\S+)/.exec(lines[i]);
    if (match) return match[1].toLowerCase() === "approved" ? "approved" : "draft";
  }
  return "draft";
}

export function parseReviewMark(value: string): ReviewMark | null {
  const text = value.trim();
  if (/^ok$/i.test(text)) return { kind: "ok" };
  const change = /^change:\s*(.+)$/i.exec(text);
  return change ? { kind: "change", note: change[1].trim() } : null;
}

export function parseAcceptance(text: string): AcceptanceFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fenced = fencedLines(lines);
  const file: AcceptanceFile = {
    status: frontMatterStatus(lines),
    tests: [],
    missing: [],
    lines: { missingHeading: null, missingEnd: null, coverageHeading: null },
  };
  // Skip front-matter, whose `---` lines are not separators.
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    start = close < 0 ? lines.length : close + 1;
  }
  const headings: number[] = [];
  for (let i = start; i < lines.length; i += 1) if (!fenced[i] && ANY_HEADING.test(lines[i])) headings.push(i);
  const blockEnd = (heading: number) => headings.find((h) => h > heading) ?? lines.length;

  for (const heading of headings) {
    if (MISSING_HEADING.test(lines[heading])) {
      const end = blockEnd(heading);
      file.lines.missingHeading = heading;
      let last = heading + 1;
      for (let i = heading + 1; i < end; i += 1) {
        const item = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (item && !fenced[i]) { file.missing.push(item[1].trim()); last = i + 1; }
      }
      file.lines.missingEnd = last;
      continue;
    }
    if (COVERAGE_HEADING.test(lines[heading])) { file.lines.coverageHeading = heading; continue; }
    const match = TEST_HEADING.exec(lines[heading]);
    if (!match) continue;
    let end = blockEnd(heading);
    while (end > heading + 1 && (lines[end - 1].trim() === "" || (RULE.test(lines[end - 1]) && !fenced[end - 1]))) end -= 1;
    file.tests.push(parseTest(lines, fenced, heading, end, match[1], match[2].trim()));
  }
  return file;
}

function parseTest(lines: string[], fenced: boolean[], heading: number, end: number, id: string, title: string): AcceptanceTestBlock {
  const test: AcceptanceTestBlock = {
    id, title, validates: "", automation: "", given: "", when: "", then: "",
    verifyHuman: "", verifyAgent: "", passesWhen: "", frames: [], review: null, visualRequests: [],
    lines: { heading, end, review: null, header: heading, requestAt: end },
  };
  let field: { name: FieldName | null; values: string[] } | null = null;
  const flush = () => {
    if (!field?.name) return;
    const value = field.values.join("\n").trim();
    switch (field.name) {
      case "frame": {
        const frame = FRAME.exec(value);
        if (frame) test.frames.push({ path: frame[1], caption: frame[2] ?? "", step: (frame[3]?.toLowerCase() as FrameStep | undefined) ?? null });
        break;
      }
      case "review": test.review = parseReviewMark(value); break;
      case "visualRequested": test.visualRequests.push(value); break;
      case "status": break;
      default: test[field.name] = value;
    }
  };
  for (let i = heading + 1; i < end; i += 1) {
    const line = lines[i];
    const label = fenced[i] ? null : FIELD.exec(line);
    if (label) {
      flush();
      const name = FIELD_NAMES[label[1].trim().toLowerCase()] ?? null;
      field = { name, values: [label[2]] };
      if (name === "review") test.lines.review = i;
      if ((name === "validates" || name === "automation" || name === "review") && test.lines.requestAt === end) test.lines.header = Math.max(test.lines.header, i);
      if ((name === "verifyHuman" || name === "verifyAgent" || name === "passesWhen" || name === "status") && test.lines.requestAt === end) test.lines.requestAt = i;
      continue;
    }
    if (!fenced[i] && RULE.test(line)) { flush(); field = null; continue; }
    // A blank line ends a single-paragraph field, except inside Verify (agent),
    // which often holds a code block and several paragraphs.
    if (line.trim() === "" && field && field.name !== "verifyAgent" && field.name !== "verifyHuman") { flush(); field = null; continue; }
    if (field) field.values.push(line);
  }
  flush();
  return test;
}
