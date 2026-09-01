// Filesystem half of the dev seeder: the showcase folder and its sample
// markdown.
//
// Split out from dev-seed.mjs because that module imports `better-sqlite3`, an
// optionalDependency and native module. Vite resolves imports at transform
// time, so a unit test covering only this filesystem logic still failed to
// load wherever the native build was skipped — and took the *entire* vitest
// run down with it ("no tests", 0% coverage) instead of failing the one test
// that needs a database. Keeping the halves apart makes the pure logic
// testable anywhere.

import fs from "node:fs";
import path from "node:path";

const DEV_DIR = path.resolve(".dev");
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

const SAMPLE_LOOP_YAML = `apiVersion: workstreams.dev/v1alpha1
kind: Loop
metadata:
  id: showcase-loop
  name: Showcase loop
  description: Catalog fixture for real-Tauri visual validation.
  tags: [showcase]
spec:
  objective: Demonstrate a valid evaluator and human-approval loop in the catalog.
  trigger:
    type: manual
  orchestrator:
    model: inherit
    prompt: Return at most one small documentation task.
    maxTasksPerRun: 1
  worker:
    model: inherit
    prompt: Complete the proposed documentation task.
  evaluator:
    model: inherit
    prompt: Confirm the result satisfies the task objective.
    onReject:
      action: revise
      maxRevisions: 1
  humanApproval:
    prompt: Review the task result and evidence before accepting it.
  limits:
    runTimeout: 5m
    taskAttempts: 2
  permissions:
    tools: full
    publicEffects: deny
  flowControl:
    maxActiveRuns: 1
`;

function ensureShowcaseFiles(
  dir = SHOWCASE_DIR,
  loopDir,
) {
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, SAMPLE_MD, "utf8");
    console.log(`[seed] wrote ${readme}`);
  } else {
    console.log(`[seed] showcase already present: ${readme}`);
  }
  if (loopDir) {
    const loopDefinition = path.join(loopDir, "showcase.loop.yaml");
    fs.mkdirSync(loopDir, { recursive: true });
    if (!fs.existsSync(loopDefinition)) {
      fs.writeFileSync(loopDefinition, SAMPLE_LOOP_YAML, "utf8");
      console.log(`[seed] wrote ${loopDefinition}`);
    } else {
      console.log(`[seed] showcase loop already present: ${loopDefinition}`);
    }
  }
}

export { ensureShowcaseFiles, SAMPLE_LOOP_YAML, SAMPLE_MD, SHOWCASE_DIR, DEV_DIR };
