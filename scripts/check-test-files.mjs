#!/usr/bin/env node
/**
 * check-test-files.mjs
 *
 * For every staged source file, verify that a corresponding test file exists.
 * Exit code 1 if any source file is missing its test.
 *
 * Skip patterns:
 * - Files in __tests__/ themselves
 * - *.test.{ts,tsx}
 * - *.types.ts (type-only files)
 * - Config files (vite.config.ts, eslint.config.js, etc.)
 * - *.css files
 * - src-tauri/src/main.rs (entry point)
 * - Files with "// @test-skip:" or "// @test-skip" in first 5 lines
 * - Generated files (anything in dist/, target/, node_modules/)
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, basename, join, extname } from "node:path";

const SKIP_NAMES = new Set([
  "main.tsx", "main.rs", "vite.config.ts", "eslint.config.js",
  "vitest.config.ts", "tauri.conf.json",
]);

const SKIP_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.types\.ts$/,
  /\.d\.ts$/,
  /\.css$/,
  /__tests__\//,
  /vite-env\.d\.ts/,
];

function shouldSkip(path) {
  if (SKIP_NAMES.has(basename(path))) return true;
  if (SKIP_PATTERNS.some((re) => re.test(path))) return true;
  // Check for @test-skip marker in first 5 lines
  try {
    const content = readFileSync(path, "utf8");
    const firstLines = content.split("\n").slice(0, 5).join("\n");
    if (/\/\/\s*@test-skip/.test(firstLines)) return true;
  } catch { /* file may not exist (deleted) */ }
  return false;
}

function findTestFile(sourcePath) {
  const dir = dirname(sourcePath);
  const ext = extname(sourcePath);
  const name = basename(sourcePath, ext);
  const candidates = [
    join(dir, "__tests__", `${name}.test${ext}`),
    join(dir, "__tests__", `${name}.test.ts`),
    join(dir, "__tests__", `${name}.test.tsx`),
    join(dir, `${name}.test${ext}`),
    join(dir, `${name}.test.ts`),
    join(dir, `${name}.test.tsx`),
  ];
  return candidates.some((c) => existsSync(c));
}

function isRustFile(path) {
  return path.endsWith(".rs");
}

function rustHasTests(path) {
  try {
    const content = readFileSync(path, "utf8");
    return /#\[cfg\(test\)\]/.test(content);
  } catch {
    return false;
  }
}

// Get staged source files
const staged = execSync("git diff --cached --name-only --diff-filter=ACMR")
  .toString()
  .split("\n")
  .filter((line) => line.trim())
  .filter((line) => {
    return (
      line.startsWith("src/") ||
      line.startsWith("src-tauri/src/")
    );
  });

const missing = [];

for (const file of staged) {
  if (shouldSkip(file)) continue;

  if (isRustFile(file)) {
    if (!rustHasTests(file)) {
      missing.push(file);
    }
  } else if (/\.(ts|tsx|js|jsx)$/.test(file)) {
    if (!findTestFile(file)) {
      missing.push(file);
    }
  }
}

if (missing.length > 0) {
  console.error("❌ The following source files are missing tests:");
  for (const f of missing) {
    console.error(`   ${f}`);
  }
  console.error("");
  console.error("Add a test file (sibling __tests__/X.test.ts or #[cfg(test)] for Rust),");
  console.error("or add a '// @test-skip: <reason>' marker in the first 5 lines.");
  process.exit(1);
}

console.log("✅ All staged source files have tests");
