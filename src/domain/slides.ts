/**
 * Slide engine — splits a markdown document into slides for "Present" mode.
 *
 * Pure + dependency-free so it is trivially unit-testable and reusable by
 * the SlideDeck component (which renders one slide at a time via the shared
 * MarkdownView).
 *
 * Splitting strategy is pluggable:
 *  - "hr" (default): split on CommonMark thematic breaks (`---`, `***`, `___`).
 *  - "heading": split before each top-level (`#`/`##`) ATX heading.
 *
 * A leading YAML frontmatter block is consumed as deck-level config (NOT a
 * slide). Only the flat scalar keys we care about are recognised.
 */

import { extractFrontmatter } from "../ui/frontmatter";

export type SplitStrategy = "hr" | "heading";

export interface DeckConfig {
  /** Multiplier applied to the base present-mode font size. */
  fontScale?: number;
  /** Optional deck title (currently informational). */
  title?: string;
}

export interface SplitResult {
  config: DeckConfig;
  /** Always at least one slide (a single empty string for a blank document). */
  slides: string[];
}

export interface SplitOptions {
  strategy?: SplitStrategy;
}

/**
 * True for a line that is a CommonMark thematic break: 3+ of the same
 * marker (`-`, `*`, `_`), optionally separated by spaces, with up to 3
 * leading spaces. Excludes setext underlines (a `---` directly under text
 * is handled by the body-level split, which only treats a thematic break
 * as a slide boundary when it stands alone — see splitOnThematicBreaks).
 */
function isThematicBreak(line: string): boolean {
  return /^ {0,3}([-*_])(?: *\1){2,} *$/.test(line);
}

function isTopLevelHeading(line: string): boolean {
  return /^#{1,2}\s+\S/.test(line);
}

/**
 * Split body text on standalone thematic breaks. A `---` is only treated as
 * a slide boundary when the preceding line is blank/absent, so a `---`
 * acting as a setext H2 underline (immediately under a text line) is NOT a
 * boundary.
 */
function splitOnThematicBreaks(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevBlank = i === 0 || lines[i - 1].trim() === "";
    if (isThematicBreak(line) && prevBlank) {
      out.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  out.push(current.join("\n"));
  return out;
}

function splitOnHeadings(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (isTopLevelHeading(line) && current.some((l) => l.trim() !== "")) {
      out.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  out.push(current.join("\n"));
  return out;
}

function parseConfig(fields: Array<{ key: string; value: string }>): DeckConfig {
  const config: DeckConfig = {};
  for (const { key, value } of fields) {
    if (key === "fontScale") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) config.fontScale = n;
    } else if (key === "title") {
      if (value) config.title = value;
    }
  }
  return config;
}

export function splitSlides(source: string, opts: SplitOptions = {}): SplitResult {
  const strategy = opts.strategy ?? "hr";
  const normalized = source.replace(/\r\n/g, "\n");

  const { fields, body, hasFrontmatter } = extractFrontmatter(normalized);
  // Only consume a leading `---` block as deck config when it actually
  // parsed `key: value` fields. A `---` followed by a blank line / content
  // (no fields) is a leading slide separator, not frontmatter — keep it in
  // the body so the splitter handles it.
  const isRealFrontmatter = hasFrontmatter && fields.length > 0;
  const config = isRealFrontmatter ? parseConfig(fields) : {};
  const content = isRealFrontmatter ? body : normalized;

  const raw = strategy === "heading"
    ? splitOnHeadings(content)
    : splitOnThematicBreaks(content);

  // Trim each slide and drop empties (e.g. from boundary separators).
  const slides = raw.map((s) => s.trim()).filter((s) => s.length > 0);

  // Always return at least one slide so the deck never has zero.
  return { config, slides: slides.length > 0 ? slides : [""] };
}
