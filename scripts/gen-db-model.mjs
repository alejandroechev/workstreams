#!/usr/bin/env node
/**
 * gen-db-model.mjs
 *
 * Generates docs/db-model.md — a Mermaid ER diagram + column reference for the
 * Workstreams SQLite schema — directly from the single source of truth,
 * `src-tauri/src/db.rs`.
 *
 * It parses the `CREATE TABLE IF NOT EXISTS` blocks and the `ALTER TABLE ...
 * ADD COLUMN` migration statements (so migration-added columns show up too),
 * plus `REFERENCES` clauses for relationships. Pure Node — no DB, no deps — so
 * it is safe to run from the pre-commit hook.
 *
 * Usage:
 *   node scripts/gen-db-model.mjs           # write docs/db-model.md
 *   node scripts/gen-db-model.mjs --check   # exit 1 if the file is stale
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const DB_RS = join(REPO, "src-tauri", "src", "db.rs");
const OUT = join(REPO, "docs", "db-model.md");

const KEYWORDS = new Set([
  "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT", "REFERENCES",
]);

/** Parse one column definition line into { name, type, pk, notNull, ref }. */
function parseColumnLine(raw) {
  const line = raw.trim().replace(/,+$/, "");
  if (!line) return null;
  const first = line.split(/\s+/)[0];
  // Skip table-level constraint lines (none in this schema, but be safe).
  if (KEYWORDS.has(first.toUpperCase())) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(first)) return null;
  const tokens = line.split(/\s+/);
  const name = tokens[0];
  const type = (tokens[1] || "TEXT").toUpperCase();
  const pk = /\bPRIMARY\s+KEY\b/i.test(line);
  const notNull = /\bNOT\s+NULL\b/i.test(line);
  const refMatch = /REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)/i.exec(line);
  const ref = refMatch ? { table: refMatch[1], column: refMatch[2] } : null;
  return { name, type, pk, notNull, ref };
}

/** Extract all CREATE TABLE blocks in declaration order. */
function parseCreateTables(src) {
  const tables = new Map(); // name -> { columns: [...] }
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)^\s*\);/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const body = m[2];
    const columns = [];
    for (const line of body.split("\n")) {
      const col = parseColumnLine(line);
      if (col) columns.push(col);
    }
    tables.set(name, { columns });
  }
  return tables;
}

/** Apply ALTER TABLE ... ADD COLUMN migrations (dedup against existing cols). */
function applyAlterColumns(src, tables) {
  const re = /ALTER TABLE (\w+) ADD COLUMN (.+?)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const table = m[1];
    const colDef = m[2].trim();
    const col = parseColumnLine(colDef);
    if (!col) continue;
    const t = tables.get(table);
    if (!t) continue; // ALTER on a table we didn't parse (shouldn't happen)
    if (t.columns.some((c) => c.name === col.name)) continue; // already present
    col.migrated = true;
    t.columns.push(col);
  }
}

function buildMermaid(tables) {
  const lines = ["erDiagram"];
  // Relationships first (Mermaid renders either order; keep them grouped).
  const rels = [];
  for (const [name, t] of tables) {
    for (const c of t.columns) {
      if (c.ref && tables.has(c.ref.table)) {
        // parent ||--o{ child : "fk_col"  (one parent, many children)
        rels.push(`  ${c.ref.table} ||--o{ ${name} : "${c.name}"`);
      }
    }
  }
  lines.push(...rels);
  for (const [name, t] of tables) {
    lines.push(`  ${name} {`);
    for (const c of t.columns) {
      const marks = [];
      if (c.pk) marks.push("PK");
      if (c.ref) marks.push("FK");
      const suffix = marks.length ? ` ${marks.join(",")}` : "";
      lines.push(`    ${c.type} ${c.name}${suffix}`);
    }
    lines.push("  }");
  }
  return lines.join("\n");
}

function buildColumnReference(tables) {
  const out = [];
  for (const [name, t] of tables) {
    out.push(`### \`${name}\`\n`);
    out.push("| Column | Type | Constraints |");
    out.push("| --- | --- | --- |");
    for (const c of t.columns) {
      const cons = [];
      if (c.pk) cons.push("PK");
      if (c.notNull) cons.push("NOT NULL");
      if (c.ref) cons.push(`FK → ${c.ref.table}.${c.ref.column}`);
      if (c.migrated) cons.push("_(migration-added)_");
      out.push(`| \`${c.name}\` | ${c.type} | ${cons.join(", ") || "—"} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

function render(tables) {
  const tableCount = tables.size;
  const colCount = [...tables.values()].reduce((n, t) => n + t.columns.length, 0);
  return `<!--
  AUTO-GENERATED — do not edit by hand.
  Source of truth: src-tauri/src/db.rs
  Regenerate: node scripts/gen-db-model.mjs
-->

# Database model

The Workstreams SQLite schema, generated from \`src-tauri/src/db.rs\`
(\`CREATE TABLE\` blocks + \`ALTER TABLE … ADD COLUMN\` migrations).
**${tableCount} tables, ${colCount} columns.**

> This file is regenerated by \`scripts/gen-db-model.mjs\` and kept in sync by the
> pre-commit hook. Edit the schema in \`db.rs\`, not here.

## ER diagram

\`\`\`mermaid
${buildMermaid(tables)}
\`\`\`

## Column reference

${buildColumnReference(tables)}`;
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(DB_RS)) {
    console.error(`gen-db-model: cannot find ${DB_RS}`);
    process.exit(2);
  }
  const src = readFileSync(DB_RS, "utf8");
  const tables = parseCreateTables(src);
  applyAlterColumns(src, tables);
  if (tables.size === 0) {
    console.error("gen-db-model: parsed 0 tables — parser or schema changed?");
    process.exit(2);
  }
  const content = render(tables);
  const existing = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  const normalize = (s) => s.replace(/\r\n/g, "\n");
  if (check) {
    if (existing === null || normalize(existing) !== normalize(content)) {
      console.error(
        "gen-db-model: docs/db-model.md is stale. Run `node scripts/gen-db-model.mjs` and stage it.",
      );
      process.exit(1);
    }
    console.log("gen-db-model: docs/db-model.md is up to date.");
    return;
  }
  writeFileSync(OUT, content);
  console.log(`gen-db-model: wrote ${OUT} (${tables.size} tables).`);
}

main();
