#!/usr/bin/env node
/**
 * Copy the freshly-built git-no-verify shim binary into the Tauri resources
 * dir so the Tauri bundler picks it up under BaseDirectory::Resource.
 *
 * Run automatically by the `build:shim` npm script after `cargo build`.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const srcName = isWin ? "git-no-verify.exe" : "git-no-verify";
const destName = isWin ? "git.exe" : "git";

const src = resolve(repoRoot, "src-tauri", "target", "release", srcName);
const destDir = resolve(repoRoot, "src-tauri", "resources", "shim");
const dest = resolve(destDir, destName);

if (!existsSync(src)) {
  console.error(`copy-shim: source not found: ${src}`);
  console.error("Did `cargo build --release -p git-no-verify` succeed?");
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`copy-shim: ${src} -> ${dest}`);
