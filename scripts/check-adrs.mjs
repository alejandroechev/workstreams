#!/usr/bin/env node
/**
 * check-adrs.mjs
 *
 * Validates the ADR corpus in docs/adrs/. Each ADR must carry a machine-readable
 * YAML-ish front-matter block at the very top of the file:
 *
 *   ---
 *   id: "007"
 *   status: Accepted
 *   date: 2026-01-15
 *   superseded_by: "014"   # optional
 *   ---
 *
 * The prose `## Status` section stays the source of truth for history and
 * narrative; the front matter only mirrors the parts a machine needs.
 *
 * Usage:
 *   node scripts/check-adrs.mjs   # exit 1 if any problem is found
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const REQUIRE_FRONT_MATTER = true;

export const ALLOWED_STATUSES = ["Accepted", "Retired", "Rewritten", "Superseded"];

const ADR_FILE_RE = /^(\d{3})-.*\.md$/;
const ID_RE = /^\d{3}$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a front-matter block delimited by `---` lines at the very top of the
 * text. Returns a plain object of string fields, or null when there is no block.
 */
export function parseFrontMatter(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;

  const end = lines.indexOf("---", 1);
  if (end === -1) return null;

  const fields = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    // Strip a trailing comment, then surrounding quotes.
    value = value.replace(/\s+#.*$/, "").trim();
    value = value.replace(/^["'](.*)["']$/, "$1");
    fields[key] = value;
  }
  return fields;
}

/** True when the string is a well-formed ISO calendar date that actually exists. */
function isIsoDate(value) {
  const m = ISO_DATE_RE.exec(value ?? "");
  if (!m) return false;
  const [, y, mo, d] = m;
  const parsed = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === Number(y) &&
    parsed.getUTCMonth() + 1 === Number(mo) &&
    parsed.getUTCDate() === Number(d)
  );
}

/** True when the README index table references this ADR by link target or number. */
function indexHasEntry(indexText, name, number) {
  if (!indexText) return false;
  if (indexText.includes(name)) return true;
  return new RegExp(`\\[\\s*${number}\\s*\\]`).test(indexText);
}

/**
 * Validates a set of ADR files against the README index.
 *
 * @param {{ files: Array<{ name: string, text: string }>, indexText: string }} input
 * @returns {string[]} one human-readable error line per problem
 */
export function validateAdrs({ files = [], indexText = "" } = {}) {
  const errors = [];
  const known = new Set();
  for (const file of files) {
    const m = ADR_FILE_RE.exec(file.name);
    if (m) known.add(m[1]);
  }

  for (const file of files) {
    const where = `docs/adrs/${file.name}`;
    const m = ADR_FILE_RE.exec(file.name);
    if (!m) continue;
    const number = m[1];

    const fm = parseFrontMatter(file.text);
    if (!fm) {
      if (REQUIRE_FRONT_MATTER) {
        errors.push(`${where}: missing front-matter block`);
      }
      continue;
    }

    if (!fm.id) {
      errors.push(`${where}: front matter is missing 'id'`);
    } else if (!ID_RE.test(fm.id)) {
      errors.push(`${where}: id '${fm.id}' is not a zero-padded 3-digit ADR number`);
    } else if (fm.id !== number) {
      errors.push(`${where}: id '${fm.id}' does not match filename prefix '${number}'`);
    }

    if (!fm.status) {
      errors.push(`${where}: front matter is missing 'status'`);
    } else if (!ALLOWED_STATUSES.includes(fm.status)) {
      errors.push(
        `${where}: status '${fm.status}' is not one of ${ALLOWED_STATUSES.join(", ")}`,
      );
    }

    if (!fm.date) {
      errors.push(`${where}: front matter is missing 'date'`);
    } else if (!isIsoDate(fm.date)) {
      errors.push(`${where}: date '${fm.date}' is not a well-formed ISO date (YYYY-MM-DD)`);
    }

    if (fm.superseded_by !== undefined) {
      if (!ID_RE.test(fm.superseded_by)) {
        errors.push(
          `${where}: superseded_by '${fm.superseded_by}' is not a zero-padded 3-digit ADR number`,
        );
      } else if (!known.has(fm.superseded_by)) {
        errors.push(
          `${where}: superseded_by '${fm.superseded_by}' points at an ADR that does not exist`,
        );
      }
    }

    if (!indexHasEntry(indexText, file.name, number)) {
      errors.push(`${where}: no row in the Index table of docs/adrs/README.md`);
    }
  }

  return errors;
}

function main() {
  const adrDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "adrs");
  const names = readdirSync(adrDir)
    .filter((n) => ADR_FILE_RE.test(n))
    .sort();
  const files = names.map((name) => ({ name, text: readFileSync(join(adrDir, name), "utf8") }));
  const indexText = readFileSync(join(adrDir, "README.md"), "utf8");

  const errors = validateAdrs({ files, indexText });
  if (errors.length > 0) {
    for (const e of errors) console.error(`❌ ${e}`);
    console.error(`\n${errors.length} ADR problem(s) found.`);
    process.exit(1);
  }

  console.log(`✅ ADRs OK — ${files.length} validated.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
