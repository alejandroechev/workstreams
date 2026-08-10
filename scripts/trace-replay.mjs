#!/usr/bin/env node
// Code walkthrough replayer — step through a recorded trace in the terminal.
//
// The "replay" half of the record/replay split (ADR 018). It touches no
// debugger and no OS-specific machinery: a trace recorded on macOS replays
// anywhere Node runs, which is what lets the Windows recorder be a fast follow
// rather than a prerequisite.
//
// It also satisfies the AGENTS.md CLI-parity rule and gives both CI and an
// agent a way to validate a trace without launching the desktop app.
//
// Usage:
//   node scripts/trace-replay.mjs <trace.json> [--list] [--step N] [--context N]
//
// Options:
//   --list        Print every step and exit (no interactive session)
//   --step N      Print step N (1-based) and exit
//   --context N   Lines of source context to show (default 3)
//
// Interactive commands: n(ext) · p(rev) · <number> · l(ist) · q(uit)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_CONTEXT_LINES = 3;

// ── Pure logic (unit-tested in __tests__/trace-replay.test.mjs) ────────────

/** Short name for display — the full Rust path is too wide for a list. */
function shortFunction(name) {
  const parts = String(name ?? "").split("::");
  return parts[parts.length - 1] || String(name ?? "");
}

/**
 * One line of the step list. `hits` is surfaced explicitly: it records that a
 * location was re-entered, and dropping it would quietly lose information the
 * recorder went to some trouble to preserve.
 */
export function formatStepLine(step, index, total, isCurrent = false) {
  const marker = isCurrent ? ">" : " ";
  const position = `${index + 1}/${total}`.padEnd(8);
  const location = `${step.file}:${step.line}`.padEnd(40);
  const hits = step.hits ? `  x${step.hits}` : "";
  return `${marker} ${position} ${location} ${shortFunction(step.function)}${hits}`;
}

/**
 * Source lines around `line` (1-based), clamped to the file.
 *
 * Returns `[]` when the line is out of range instead of throwing: a stale
 * trace can point past the end of an edited file, and replay on a stale trace
 * is explicitly allowed (the UI shows a banner rather than blocking).
 */
export function sourceContext(lines, line, contextLines) {
  if (!Array.isArray(lines) || line < 1 || line > lines.length) return [];
  const first = Math.max(1, line - contextLines);
  const last = Math.min(lines.length, line + contextLines);
  const out = [];
  for (let n = first; n <= last; n++) {
    out.push({ line: n, text: lines[n - 1], isTarget: n === line });
  }
  return out;
}

/** Full detail view for one step: location, function, and source context. */
export function formatStepDetail(step, index, total, sourceLines, contextLines = DEFAULT_CONTEXT_LINES) {
  const header = [
    `Step ${index + 1} of ${total}`,
    `${step.file}:${step.line}`,
    `fn ${step.function}${step.hits ? `   (visited ${step.hits}x consecutively)` : ""}`,
  ].join("\n");

  const context = sourceContext(sourceLines, step.line, contextLines);
  if (context.length === 0) {
    return `${header}\n\n  (source unavailable — the file may have changed since recording)`;
  }
  const body = context
    .map((c) => `${c.isTarget ? "→" : " "} ${String(c.line).padStart(5)} | ${c.text}`)
    .join("\n");
  return `${header}\n\n${body}`;
}

/** Map a typed line to a command. Unknown input is reported, never guessed. */
export function parseReplayCommand(input) {
  const raw = String(input ?? "").trim();
  const normalized = raw.toLowerCase();

  if (normalized === "" || normalized === "n" || normalized === "next") return { type: "next" };
  if (normalized === "p" || normalized === "prev" || normalized === "previous") return { type: "prev" };
  if (normalized === "l" || normalized === "list") return { type: "list" };
  if (normalized === "q" || normalized === "quit" || normalized === "exit") return { type: "quit" };

  // The display is 1-based, so input is too — making the user subtract one is
  // a reliable source of off-by-one confusion.
  const bare = /^(\d+)$/.exec(normalized);
  if (bare) return { type: "goto", index: Number(bare[1]) - 1 };
  const goto = /^goto\s+(\d+)$/.exec(normalized);
  if (goto) return { type: "goto", index: Number(goto[1]) - 1 };

  return { type: "unknown", input: raw };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function loadTrace(file) {
  const raw = fs.readFileSync(file, "utf8");
  let trace;
  try {
    trace = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message})`);
  }
  if (trace?.version !== 1) {
    throw new Error(`${file} declares version ${trace?.version}; this build supports version 1.`);
  }
  if (!Array.isArray(trace.steps)) throw new Error(`${file} has no "steps" array`);
  return trace;
}

const sourceCache = new Map();
function readSource(repoRoot, relativeFile) {
  if (sourceCache.has(relativeFile)) return sourceCache.get(relativeFile);
  let lines = null;
  try {
    lines = fs.readFileSync(path.resolve(repoRoot, relativeFile), "utf8").split("\n");
  } catch {
    lines = null; // deleted, moved, or recorded on another machine
  }
  sourceCache.set(relativeFile, lines);
  return lines;
}

function printList(trace, currentIndex) {
  trace.steps.forEach((step, i) => {
    console.log(formatStepLine(step, i, trace.steps.length, i === currentIndex));
  });
}

function printStep(trace, index, contextLines) {
  const step = trace.steps[index];
  const lines = readSource(trace.repoRoot, step.file);
  console.log("");
  console.log(formatStepDetail(step, index, trace.steps.length, lines, contextLines));
  console.log("");
}

function main() {
  const argv = process.argv.slice(2);
  const valueOf = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const file = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);

  if (!file) {
    console.error("usage: node scripts/trace-replay.mjs <trace.json> [--list] [--step N] [--context N]");
    process.exitCode = 1;
    return;
  }

  const trace = loadTrace(file);
  const contextLines = Number(valueOf("--context", String(DEFAULT_CONTEXT_LINES)));

  console.error(`[trace-replay] ${trace.test}`);
  console.error(`[trace-replay] ${trace.steps.length} steps, recorded ${trace.recordedAt} @ ${trace.commitSha.slice(0, 7)}`);
  if (trace.truncated) console.error("[trace-replay] WARNING: this trace is truncated (hit the step cap).");
  if (trace.steps.length === 0) {
    console.error("[trace-replay] this trace has no steps.");
    return;
  }

  if (argv.includes("--list")) {
    printList(trace, -1);
    return;
  }

  const stepArg = valueOf("--step", null);
  if (stepArg !== null) {
    const index = Math.min(Math.max(Number(stepArg) - 1, 0), trace.steps.length - 1);
    printStep(trace, index, contextLines);
    return;
  }

  let index = 0;
  printStep(trace, index, contextLines);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("(n)ext (p)rev <number> (l)ist (q)uit > ");
  rl.prompt();

  rl.on("line", (line) => {
    const command = parseReplayCommand(line);
    switch (command.type) {
      case "next":
        index = Math.min(index + 1, trace.steps.length - 1);
        printStep(trace, index, contextLines);
        break;
      case "prev":
        // Free in a replay model, and impossible in a live debugger.
        index = Math.max(index - 1, 0);
        printStep(trace, index, contextLines);
        break;
      case "goto":
        index = Math.min(Math.max(command.index, 0), trace.steps.length - 1);
        printStep(trace, index, contextLines);
        break;
      case "list":
        printList(trace, index);
        break;
      case "quit":
        rl.close();
        return;
      default:
        console.log(`unknown command: ${command.input}`);
    }
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error("[trace-replay] failed:", e.message);
    process.exitCode = 1;
  }
}
