#!/usr/bin/env node
/**
 * discipline-audit.mjs
 *
 * Audit current state of dev discipline:
 * - Source files changed recently without test files modified
 * - Source files changed without doc files modified
 * - Time since last CDP screenshot
 * - Uncommitted source changes lacking tests
 *
 * Output: concise status report (markdown-ish) to stdout.
 * Exit code: 0 always (informational). Use specific scripts for blocking.
 */
import { execSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname, extname } from "node:path";

const SOURCE_DIRS = ["src", "src-tauri/src"];
const DOC_PATHS = ["README.md", "docs/system-diagram.md", "docs/adrs"];

function shellOk(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// 1. Files changed in the last 7 days (committed)
const recentFiles = shellOk('git log --since="7 days ago" --name-only --pretty=format:').split("\n").filter(Boolean);
const uniqueRecent = Array.from(new Set(recentFiles));

// 2. Uncommitted changes
const uncommitted = shellOk("git diff --name-only HEAD").split("\n").filter(Boolean);
const staged = shellOk("git diff --cached --name-only").split("\n").filter(Boolean);
const allUncommitted = Array.from(new Set([...uncommitted, ...staged]));

// 3. Categorize files
function isSource(path) {
  return SOURCE_DIRS.some((d) => path.startsWith(d + "/") || path.startsWith(d + "\\"));
}
function isTest(path) {
  return /__tests__\//.test(path) || /\.test\.(ts|tsx|js|jsx)$/.test(path);
}
function isDoc(path) {
  return DOC_PATHS.some((d) => path === d || path.startsWith(d + "/"));
}
function isStyleOrConfig(path) {
  return /\.css$/.test(path) || /(^|\/)vite\.config\.ts$/.test(path) || /eslint\.config/.test(path);
}

const recentSource = uniqueRecent.filter(isSource).filter((f) => !isStyleOrConfig(f));
const recentTests = uniqueRecent.filter(isTest);
const recentDocs = uniqueRecent.filter(isDoc);

const uncommittedSource = allUncommitted.filter(isSource).filter((f) => !isStyleOrConfig(f));
const uncommittedTests = allUncommitted.filter(isTest);

// 4. Time since last screenshot
let lastScreenshotAge = "no screenshots yet";
let lastScreenshotPath = null;
const screenshotDir = "screenshots";
if (existsSync(screenshotDir)) {
  const entries = readdirSync(screenshotDir)
    .filter((n) => n.endsWith(".png"))
    .map((n) => ({ name: n, path: join(screenshotDir, n), mtime: statSync(join(screenshotDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length > 0) {
    const ageMs = Date.now() - entries[0].mtime;
    const hours = Math.floor(ageMs / (1000 * 60 * 60));
    lastScreenshotAge = hours < 1 ? "<1h" : `${hours}h`;
    lastScreenshotPath = entries[0].name;
  }
}

// 5. Plan status (optional — requires SESSION_DB env var set by the extension)
let planStatus = null;
try {
  const dbPath = process.env.SESSION_DB;
  if (dbPath && existsSync(dbPath)) {
    // Use Node's built-in or sqlite3 if available — fall back to a python child for safety
    const { execSync } = await import("node:child_process");
    const out = execSync(
      `python -c "import sqlite3,json; c=sqlite3.connect('${dbPath.replace(/\\/g, "\\\\")}'); c.row_factory=sqlite3.Row; rows=[dict(r) for r in c.execute('SELECT status, COUNT(*) as count FROM plans GROUP BY status').fetchall()]; current=c.execute('SELECT p.id, p.title FROM current_plan cp JOIN plans p ON p.id=cp.plan_id WHERE cp.id=1').fetchone(); stale=c.execute(\\"SELECT COUNT(*) FROM todos t JOIN plans p ON p.id=t.plan_id WHERE p.status='superseded' AND t.status IN ('pending','in_progress')\\").fetchone()[0]; print(json.dumps({'plans': rows, 'current': dict(current) if current else None, 'stale': stale}))"`,
      { encoding: "utf8" }
    );
    planStatus = JSON.parse(out.trim());
  }
} catch { /* optional, ignore */ }

// 6. Print report
console.log("📋 DISCIPLINE AUDIT");
console.log("═══════════════════════════════════════════════════");

if (planStatus && planStatus.current) {
  console.log(`\n📋 Active plan: ${planStatus.current.title || planStatus.current.id}`);
  if (planStatus.plans.length > 0) {
    const summary = planStatus.plans.map((p) => `${p.status}=${p.count}`).join(", ");
    console.log(`   Plans by status: ${summary}`);
  }
  if (planStatus.stale > 0) {
    console.log(`   ⚠️  ${planStatus.stale} pending todos in superseded plans (stale work)`);
  }
}

if (recentSource.length === 0 && allUncommitted.length === 0) {
  console.log("✅ No recent source changes. Discipline state is neutral.");
} else {
  // Source vs test
  if (recentSource.length > 0) {
    console.log(`\n📝 Source files changed (7d): ${recentSource.length}`);
    console.log(`   Test files changed (7d): ${recentTests.length}`);
    if (recentSource.length > recentTests.length * 2) {
      console.log(`   ⚠️  Test count looks low (ratio source/test = ${(recentSource.length / Math.max(recentTests.length, 1)).toFixed(1)})`);
    } else {
      console.log(`   ✅ Test ratio looks healthy`);
    }
  }

  // Source vs docs
  if (recentSource.length > 5 && recentDocs.length === 0) {
    console.log(`\n📚 ⚠️  ${recentSource.length} source files changed in 7d but NO docs touched`);
    console.log(`   Consider: README, docs/system-diagram.md, or docs/adrs/`);
  } else if (recentDocs.length > 0) {
    console.log(`\n📚 ✅ ${recentDocs.length} doc file(s) touched in 7d`);
  }

  // Uncommitted source without tests
  if (uncommittedSource.length > 0) {
    const sourceNamesWithoutTests = uncommittedSource.filter((src) => {
      if (isStyleOrConfig(src)) return false;
      const base = basename(src, extname(src));
      const dir = dirname(src);
      // Check if any uncommitted test file matches
      const testCandidates = [
        join(dir, "__tests__", `${base}.test.ts`),
        join(dir, "__tests__", `${base}.test.tsx`),
        join(dir, `${base}.test.ts`),
      ].map((p) => p.replace(/\\/g, "/"));
      return !uncommittedTests.some((t) => testCandidates.includes(t.replace(/\\/g, "/")));
    });
    if (sourceNamesWithoutTests.length > 0) {
      console.log(`\n🧪 ⚠️  ${sourceNamesWithoutTests.length} uncommitted source file(s) without matching test changes:`);
      for (const f of sourceNamesWithoutTests.slice(0, 5)) {
        console.log(`   ${f}`);
      }
      if (sourceNamesWithoutTests.length > 5) {
        console.log(`   ... and ${sourceNamesWithoutTests.length - 5} more`);
      }
    }
  }

  // Screenshot age
  console.log(`\n📸 Last screenshot: ${lastScreenshotAge}${lastScreenshotPath ? ` (${lastScreenshotPath})` : ""}`);
  if (recentSource.some((f) => /src\/(tiles|tiling|workstream)\//.test(f))) {
    console.log(`   ℹ️  UI code was touched recently — consider running 'npm run validate-feature'`);
  }
}

console.log("\n═══════════════════════════════════════════════════");
console.log("Tips:");
console.log("  • Run 'npm run validate-feature <name>' for CDP screenshot");
console.log("  • For features, INSERT into todos with category='feature' to get auto sub-todos");
