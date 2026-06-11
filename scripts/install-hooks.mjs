#!/usr/bin/env node
/**
 * Wire git's hooks path to the repo-managed `.githooks` directory.
 *
 * Runs automatically via `npm` lifecycle (postinstall) so every fresh
 * clone + `npm ci` ends up with the same gates installed. Safe to re-run.
 *
 * If we are not inside a git working copy (e.g. shallow CI install of
 * the npm package), this is a no-op so the install doesn't fail.
 */
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const hooksDir = join(repoRoot, ".githooks");

function isInsideGitWorkTree() {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!isInsideGitWorkTree()) {
  console.log("[install-hooks] not a git work tree — skipping");
  process.exit(0);
}

if (!existsSync(hooksDir)) {
  console.log(`[install-hooks] ${hooksDir} not found — skipping`);
  process.exit(0);
}

// Make every hook file executable. On Windows this is a no-op; on
// macOS/Linux it ensures the bits survive a fresh clone (npm strips
// execute bits sometimes).
for (const f of readdirSync(hooksDir)) {
  if (f.startsWith(".")) continue;
  try {
    chmodSync(join(hooksDir, f), 0o755);
  } catch {
    /* best effort */
  }
}

// Idempotent: writes the value even if already correct.
execSync("git config core.hooksPath .githooks", { cwd: repoRoot, stdio: "inherit" });
console.log("[install-hooks] git core.hooksPath -> .githooks");
