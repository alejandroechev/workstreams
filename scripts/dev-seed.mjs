// Idempotent seeder for the dev DB and showcase folder.
// Uses better-sqlite3 (zero PATH dependency).

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DEV_DIR = path.resolve(".dev");
const DB_PATH = process.env.WORKSTREAMS_DB_PATH || path.join(DEV_DIR, "workstreams-dev.db");
const SHOWCASE_DIR = path.join(DEV_DIR, "showcase");

const SAMPLE_MD = `# Markdown Showcase

This file exercises every supported markdown feature so visual validation
can compare rendering against the VS Code dark theme.

## Headings

### H3
#### H4
##### H5

## Inline formatting

This is **bold**, *italic*, ~~strike~~, and \`inline code\`. Visit
[the repo](https://github.com/alejandroechev/workstreams) for more.

## Blockquote

> A blockquote should have a left border, italic style, and slightly muted
> text. It can span multiple lines.

## Lists

- Bullet one
- Bullet two
  - Nested
- Bullet three

1. Ordered one
2. Ordered two

## Table

| Column A | Column B | Column C |
|----------|----------|----------|
| 1        | foo      | true     |
| 2        | bar      | false    |

## Code (TypeScript)

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

## Code (Rust)

\`\`\`rust
fn main() {
    println!("Hello, world!");
}
\`\`\`

## Mermaid diagram

\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant A as App<br/>(MarkdownView)
    participant M as MermaidDiagram
    U->>A: Open .md file
    A->>M: code block with language-mermaid
    M-->>A: rendered SVG with panzoom
    A-->>U: show diagram
\`\`\`

---

End of showcase.
`;

function ensureShowcaseFiles(dir = SHOWCASE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, SAMPLE_MD, "utf8");
    console.log(`[seed] wrote ${readme}`);
  } else {
    console.log(`[seed] showcase already present: ${readme}`);
  }
}

function runSqlite(sql, params = []) {
  const db = new Database(DB_PATH);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function dbHasWorkstreams() {
  if (!fs.existsSync(DB_PATH)) return false;
  try {
    const rows = runSqlite("SELECT COUNT(*) AS n FROM workstreams");
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

function seedDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.log(
      `[seed] DB not yet present at ${DB_PATH} — run cargo tauri dev first so schema is created.`,
    );
    console.log("[seed] DB seeding skipped; showcase files written.");
    return false;
  }
  const db = new Database(DB_PATH);
  try {
    ensureWorkstream(db, "Showcase", SHOWCASE_DIR, "Markdown + mermaid fixture for CDP validation");
    ensureWorkstream(db, "Sandbox", DEV_DIR, "Second workstream for focus/scroll repro");
  } finally {
    db.close();
  }
  return true;
}

function ensureWorkstream(db, name, directory, description) {
  const existing = db
    .prepare("SELECT id FROM workstreams WHERE name = ?")
    .get(name);
  if (existing) {
    console.log(`[seed] workstream '${name}' already exists (id=${existing.id})`);
    ensureLayout(db, existing.id);
    return existing.id;
  }
  const id = `${name.toLowerCase()}-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workstreams (id, name, description, directory, status, workstream_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 'standalone', ?, ?)`,
  ).run(id, name, description, directory, now, now);
  ensureLayout(db, id);
  console.log(`[seed] inserted workstream '${name}' id=${id}`);
  return id;
}

function ensureLayout(db, workstreamId) {
  // Mirror what create_workstream does in lib.rs — without this row,
  // update_layout (which uses UPDATE not UPSERT) silently no-ops and
  // tile_order_json never gets persisted.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO workstream_layouts (workstream_id, layout_mode, tile_order_json, updated_at)
     VALUES (?, 'adaptive', '[]', ?)`,
  ).run(workstreamId, now);
}

function main() {
  ensureShowcaseFiles();
  try {
    seedDb();
  } catch (err) {
    console.warn(`[seed] DB seeding skipped: ${err.message}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("dev-seed.mjs")) {
  main();
}

export { ensureShowcaseFiles, seedDb, dbHasWorkstreams, SAMPLE_MD, SHOWCASE_DIR, DB_PATH };
