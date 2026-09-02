/**
 * Plain-text link detection.
 *
 * Task activity-log entries and notes are stored as plain text, never HTML.
 * To make URLs actionable we split the string into text/link segments here,
 * so the renderer can emit real React nodes and never needs
 * `dangerouslySetInnerHTML` (which would let stored text inject markup).
 */

export type LinkSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string };

/**
 * Greedy scheme match. Trailing characters are trimmed afterwards so that
 * ordinary sentence punctuation ("see https://x.dev.") is not swallowed into
 * the href.
 */
const URL_RE = /https?:\/\/[^\s<]+/gi;

/** Punctuation that is far more likely to end the sentence than the URL. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "]", "}", ")"]);

/**
 * Trim trailing punctuation off a raw match, keeping balanced parens (as in
 * Wikipedia-style URLs) attached to the link.
 */
function trimTrailing(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (!TRAILING.has(ch)) break;
    if (ch === ")") {
      const slice = raw.slice(0, end);
      const opens = (slice.match(/\(/g) ?? []).length;
      const closes = (slice.match(/\)/g) ?? []).length;
      if (opens >= closes) break;
    }
    end -= 1;
  }
  return raw.slice(0, end);
}

/** Split `text` into ordered plain-text and URL segments. Empty in, empty out. */
export function splitLinks(text: string): LinkSegment[] {
  if (!text) return [];
  const segments: LinkSegment[] = [];
  let cursor = 0;
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const url = trimTrailing(match[0]);
    if (match.index > cursor) {
      segments.push({ kind: "text", value: text.slice(cursor, match.index) });
    }
    segments.push({ kind: "link", value: url });
    cursor = match.index + url.length;
    re.lastIndex = cursor;
  }
  if (cursor < text.length) segments.push({ kind: "text", value: text.slice(cursor) });
  return segments;
}

/** True when `text` contains at least one http(s) URL. */
export function hasLink(text: string): boolean {
  return splitLinks(text).some((s) => s.kind === "link");
}
