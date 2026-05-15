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

function ensureShowcaseFiles() {
  fs.mkdirSync(SHOWCASE_DIR, { recursive: true });
  const readme = path.join(SHOWCASE_DIR, "README.md");
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
  if (dbHasWorkstreams()) {
    console.log("[seed] DB already has workstreams — leaving as-is (idempotent).");
    return false;
  }
  const id = `showcase-${Date.now()}`;
  const now = new Date().toISOString();
  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `INSERT INTO workstreams (id, name, description, directory, status, workstream_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 'standalone', ?, ?)`,
    ).run(id, "Showcase", "Markdown + mermaid fixture for CDP validation", SHOWCASE_DIR, now, now);
  } finally {
    db.close();
  }
  console.log(`[seed] inserted Showcase workstream id=${id}`);
  return true;
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
