#!/usr/bin/env node
// List Rust tests for the Code Walkthrough picker without opening the app.
//
// This is CLI parity for the tile's explicit "Load tests" action. A package
// filter maps to Cargo's `-p` and materially reduces compilation in a large
// workspace. A name filter is passed to each libtest binary's `--list`
// command; it narrows output but does not reduce compilation.
//
// Usage:
//   node scripts/trace-tests.mjs [options]
//
// Options:
//   --manifest-dir <dir>   Repo/crate root (default: src-tauri)
//   --package <name>       Cargo package (`-p`) to build
//   --filter <text>        Test-name substring passed to libtest

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { selectTestExecutables } from "./trace-record.mjs";
import { cargoBuildArgs, parseTestList, testListArgs } from "./trace-test-list.mjs";

export function parseArgs(argv) {
  const valueOf = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    manifestDir: path.resolve(valueOf("--manifest-dir", "src-tauri")),
    package: valueOf("--package"),
    filter: valueOf("--filter"),
  };
}

export function listRustTests(opts) {
  const buildArgs = cargoBuildArgs(opts.package);
  const cargoOut = execFileSync("cargo", buildArgs, {
    cwd: opts.manifestDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const executables = selectTestExecutables(cargoOut);
  if (executables.length === 0) {
    throw new Error("cargo produced no test executable");
  }

  const tests = new Set();
  const listArgs = testListArgs(opts.filter);
  for (const { exe } of executables) {
    const output = execFileSync(exe, listArgs, {
      cwd: opts.manifestDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const test of parseTestList(output)) tests.add(test);
  }
  return [...tests].sort();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  for (const test of listRustTests(opts)) console.log(test);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error("[trace-tests] failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
