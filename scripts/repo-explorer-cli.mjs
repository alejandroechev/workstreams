#!/usr/bin/env node
// Repo Explorer CLI — feature-parity with the RepoExplorerTile content search.
//
// Implements the same case-insensitive substring search as the Rust
// `search_in_files` Tauri command, with identical skip-dir / 1 MB / per-file
// caps. Useful as a CLI scenario when the desktop tile isn't available.
//
// Usage:
//   node scripts/repo-explorer-cli.mjs <directory> <query> [--limit N] [--names]
//
// Flags:
//   --names   filename-only search (Ctrl+P equivalent)
//   --limit N max total matches (default 200 for content, 50 for names)
//
// Examples:
//   node scripts/repo-explorer-cli.mjs . "search_in_files"
//   node scripts/repo-explorer-cli.mjs src "TODO" --limit 20
//   node scripts/repo-explorer-cli.mjs . "Repo" --names

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  ".git",
  "dist",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  ".turbo",
  ".cargo",
  ".dev",
  "build",
  "out",
  ".vite",
  "coverage",
]);
const MAX_FILE_SIZE = 1_048_576; // 1 MB
const MAX_PER_FILE = 5;

function parseArgs(argv) {
  const args = { _: [], limit: undefined, names: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--names") args.names = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.split("=")[1], 10);
    else args._.push(a);
  }
  return args;
}

function searchFilenames(root, query, limit) {
  const max = limit ?? 50;
  const q = query.toLowerCase();
  const results = [];
  const queue = [root];
  while (queue.length > 0 && results.length < max) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (results.length >= max) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
      } else if (e.name.toLowerCase().includes(q)) {
        results.push(full);
      }
    }
  }
  return results;
}

function searchInFiles(root, query, limit) {
  const max = limit ?? 200;
  const q = query.toLowerCase();
  if (!q.trim()) return [];
  const results = [];
  const queue = [root];
  while (queue.length > 0 && results.length < max) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (results.length >= max) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
        continue;
      }
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > MAX_FILE_SIZE) continue;
      let content;
      try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
      const lines = content.split("\n");
      let perFile = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({ path: full, line_number: i + 1, line_text: lines[i].slice(0, 240) });
          perFile++;
          if (perFile >= MAX_PER_FILE || results.length >= max) break;
        }
      }
    }
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length < 2) {
    console.error("Usage: node scripts/repo-explorer-cli.mjs <directory> <query> [--limit N] [--names]");
    process.exit(2);
  }
  const [dir, query] = args._;
  if (args.names) {
    const results = searchFilenames(dir, query, args.limit);
    for (const p of results) console.log(p);
    console.error(`\n${results.length} file name match(es)`);
  } else {
    const results = searchInFiles(dir, query, args.limit);
    for (const m of results) {
      console.log(`${m.path}:${m.line_number}: ${m.line_text}`);
    }
    console.error(`\n${results.length} content match(es)`);
  }
}

main();
