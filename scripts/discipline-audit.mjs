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

// 5. Print report
console.log("📋 DISCIPLINE AUDIT");
console.log("═══════════════════════════════════════════════════");

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
