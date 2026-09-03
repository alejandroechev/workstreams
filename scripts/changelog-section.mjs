#!/usr/bin/env node
/**
 * changelog-section.mjs
 *
 * Extracts one version's section from a Keep a Changelog file so the release
 * workflow can lead with a curated, user-facing summary instead of a machine
 * line like "Manual release for commit <sha>".
 *
 * Usage:
 *   node scripts/changelog-section.mjs v0.8.0            # print, exit 1 if absent
 *   node scripts/changelog-section.mjs v0.8.0 --optional # print, exit 0 if absent
 *   node scripts/changelog-section.mjs --unreleased
 *
 * Version matching is tolerant of a leading "v" on either side, so `v0.8.0`
 * finds a `## [0.8.0] - 2026-09-03` heading and vice versa.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHANGELOG_PATH = join(HERE, "..", "CHANGELOG.md");

/** Strip a single leading "v" so v1.2.3 and 1.2.3 compare equal. */
export function normalizeVersion(version) {
  return String(version ?? "").trim().replace(/^v/i, "");
}

/**
 * Parse a Keep a Changelog document into ordered sections.
 *
 * A section starts at a level-2 heading whose text contains a bracketed
 * version — `## [0.8.0] - 2026-09-03` or `## [Unreleased]` — and runs until the
 * next level-2 heading. Link-reference definitions at the foot of the file are
 * not part of any section.
 */
export function parseChangelog(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const heading = /^##\s+\[([^\]]+)\]\s*(?:-\s*(\S+))?\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { version: heading[1].trim(), date: heading[2] ?? null, body: [] };
      continue;
    }
    // Link-reference definitions belong to the document, not to a section.
    if (/^\[[^\]]+\]:\s+\S+/.test(line)) continue;
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);

  return sections.map((s) => ({ ...s, body: s.body.join("\n").trim() }));
}

/** Return the body for a version, or null when it has no section or no content. */
export function sectionFor(text, version) {
  const wanted = normalizeVersion(version);
  const match = parseChangelog(text).find(
    (s) => normalizeVersion(s.version) === wanted,
  );
  if (!match || !match.body) return null;
  return match.body;
}

function main(argv) {
  const args = argv.slice(2);
  const optional = args.includes("--optional");
  const unreleased = args.includes("--unreleased");
  const version = unreleased
    ? "Unreleased"
    : args.find((a) => !a.startsWith("--"));

  if (!version) {
    console.error("usage: changelog-section.mjs <version|--unreleased> [--optional]");
    return 2;
  }
  if (!existsSync(CHANGELOG_PATH)) {
    if (optional) return 0;
    console.error(`changelog-section: ${CHANGELOG_PATH} not found`);
    return 1;
  }

  const body = sectionFor(readFileSync(CHANGELOG_PATH, "utf8"), version);
  if (!body) {
    if (optional) return 0;
    console.error(`changelog-section: no entry for ${version}`);
    return 1;
  }
  process.stdout.write(body + "\n");
  return 0;
}

// Only run as a CLI, so the module stays importable from tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
