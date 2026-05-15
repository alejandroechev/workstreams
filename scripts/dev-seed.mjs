// Idempotent seeder for the dev DB and showcase folder.
// Creates a "Showcase" workstream pointing at .dev/showcase/ and populates
// the folder with a markdown+mermaid sample, only if no workstreams exist yet.
//
// Uses better-sqlite3 if available; otherwise falls back to sqlite3 via raw
// `sqlite3` CLI binary. Keeps the script tiny and dep-free.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

function runSqlite(sql) {
  // Use the rusqlite-compatible "sqlite3" binary if available.
  const r = spawnSync("sqlite3", [DB_PATH, sql], { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`sqlite3 failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function dbHasWorkstreams() {
  if (!fs.existsSync(DB_PATH)) return false;
  try {
    const out = runSqlite("SELECT COUNT(*) FROM workstreams;").trim();
    return Number(out) > 0;
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
  const directory = SHOWCASE_DIR.replace(/'/g, "''");
  const sql = `INSERT INTO workstreams (id, name, description, directory, status, workstream_type, created_at, updated_at) VALUES ('${id}', 'Showcase', 'Markdown + mermaid fixture for CDP validation', '${directory}', 'active', 'standalone', '${now}', '${now}');`;
  runSqlite(sql);
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

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("dev-seed.mjs")) {
  main();
}

export { ensureShowcaseFiles, seedDb, dbHasWorkstreams, SAMPLE_MD, SHOWCASE_DIR, DB_PATH };
