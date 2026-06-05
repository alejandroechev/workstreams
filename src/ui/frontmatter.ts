/**
 * Strips a leading YAML frontmatter block from a markdown source and
 * returns the parsed key/value pairs alongside the remaining body.
 *
 * Matches the standard convention used by Jekyll, MkDocs, Obsidian, and
 * Copilot CLI skill files:
 *
 *   ---
 *   key: value
 *   name: something
 *   ---
 *   # Actual markdown body
 *
 * No external YAML dependency — only flat scalar `key: value` pairs are
 * supported (which is all our skill front-matter uses). Multi-line values
 * are joined; arrays/objects fall back to the raw string.
 */
export interface ParsedFrontmatter {
  /** Ordered key/value pairs; `null` for blank values. */
  fields: Array<{ key: string; value: string }>;
  /** Markdown body with the frontmatter block removed. */
  body: string;
  /** True iff a leading frontmatter block was found. */
  hasFrontmatter: boolean;
}

export function extractFrontmatter(source: string): ParsedFrontmatter {
  // Normalize line endings so we don't have to worry about CRLF.
  const text = source.replace(/\r\n/g, "\n");
  // Frontmatter must start at byte 0 with exactly `---` on its own line.
  if (!text.startsWith("---\n")) {
    return { fields: [], body: source, hasFrontmatter: false };
  }
  const closeIdx = text.indexOf("\n---", 4);
  if (closeIdx < 0) {
    return { fields: [], body: source, hasFrontmatter: false };
  }
  const block = text.slice(4, closeIdx);
  // Body starts after the closing `---` (and its trailing newline if any).
  const afterClose = closeIdx + 4;
  const body = text.charAt(afterClose) === "\n"
    ? text.slice(afterClose + 1)
    : text.slice(afterClose);
  const fields: Array<{ key: string; value: string }> = [];
  // Simple flat parse: `key: value` per line. Continuation lines (start
  // with whitespace) are appended to the previous value with a space.
  for (const line of block.split("\n")) {
    if (line.trim().length === 0) continue;
    if (/^\s/.test(line) && fields.length > 0) {
      fields[fields.length - 1].value += " " + line.trim();
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) {
      fields.push({ key: m[1], value: m[2].trim() });
    }
  }
  return { fields, body, hasFrontmatter: true };
}
