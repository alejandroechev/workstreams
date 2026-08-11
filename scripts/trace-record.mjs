#!/usr/bin/env node
// Code walkthrough recorder — captures a Rust `#[test]`'s execution as an
// ordered list of source locations, by driving `lldb-dap` over the Debug
// Adapter Protocol.
//
// This is the "record" half of the record/replay split (see ADR 018). It runs
// as a plain CLI, outside the desktop app, so the OS-dependent part of the
// feature (spawning a debugger) never needs entitlements inside a bundled
// Tauri app — and so replay stays portable to platforms whose recorder does
// not exist yet.
//
// Usage:
//   node scripts/trace-record.mjs --test <test::path> [options]
//
// Options:
//   --test <name>          Fully-qualified test name (required)
//   --out <path>           Write the trace JSON here (default: stdout)
//   --steps <n>            Max debugger steps before truncating (default 2000)
//   --manifest-dir <dir>   Cargo manifest directory (default: src-tauri)
//   --repo-root <dir>      Repo root; frames outside it are stepped over
//   --verbose              Log the DAP conversation to stderr
//
// Examples:
//   node scripts/trace-record.mjs --test pty::tests::resolves_shell
//   node scripts/trace-record.mjs --test shell_env::tests::merge_paths --out /tmp/t.json

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Schema version written by this recorder. Must match domain/trace-format.ts. */
export const TRACE_FORMAT_VERSION = 1;

const DEFAULT_MAX_STEPS = 2000;
/** A single DAP request should never legitimately take this long. */
const REQUEST_TIMEOUT_MS = 30_000;

// ── Pure logic (unit-tested in __tests__/trace-record.test.mjs) ────────────

/**
 * Pick the test executable out of `cargo test --no-run --message-format=json`.
 *
 * Cargo reports the built path directly, which avoids guessing the hash suffix
 * it appends (`workstreams_lib-fa7744cd280bb6c7`). Unit tests live in the lib
 * target, so that one wins when several test binaries were built.
 */
export function selectTestExecutable(stdout) {
  const candidates = [];
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // cargo interleaves human-readable progress lines
    }
    if (msg?.profile?.test && msg?.executable) {
      candidates.push({ name: msg.target?.name ?? "", exe: msg.executable });
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      "no test executable found — `cargo test --no-run` produced no test binary. " +
        "Check that the manifest directory is correct and the crate compiles.",
    );
  }
  const lib = candidates.find((c) => c.name.endsWith("_lib")) ?? candidates[0];
  return lib.exe;
}

/**
 * Whether a stack frame belongs to the code under study.
 *
 * This is the step-out trigger. Without it, a single `assert_eq!` descends
 * into thousands of frames of `core`/`alloc`/formatting machinery — the trace
 * would be dominated by code the reader did not ask about and often has no
 * source for. Generated code under `target/` is excluded for the same reason.
 */
export function isOurCode(file, repoRoot) {
  if (!file) return false;
  const abs = path.resolve(file);
  const root = path.resolve(repoRoot);
  // The separator guard stops `/repo-other` from matching root `/repo`.
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  return !abs.includes(`${path.sep}target${path.sep}`);
}

/** Strip rustc's `::h<hash>` suffix from a symbol name. */
export function demangle(name) {
  if (!name) return "";
  return String(name).split("::h")[0];
}

/**
 * Append a location, collapsing it into the previous entry when identical.
 *
 * A line such as `Some(s) if s.trim().starts_with('/')` makes several std
 * calls; the recorder steps into each and immediately back out, landing on
 * that same line every time. Recorded raw, the reader sees one line repeated
 * eight times — debugger mechanics presented as execution history.
 *
 * Only *consecutive* duplicates collapse, so loop revisits (52 → 53 → 52)
 * survive intact: control returns via a different line first.
 */
export function appendStep(steps, step) {
  const prev = steps[steps.length - 1];
  if (prev && prev.file === step.file && prev.line === step.line && prev.function === step.function) {
    prev.hits = (prev.hits ?? 1) + 1;
    return steps;
  }
  const next = { file: step.file, line: step.line, function: step.function };
  if (step.depth !== undefined) next.depth = step.depth;
  steps.push(next);
  return steps;
}

/**
 * Assemble the on-disk trace. `vars` is deliberately never emitted in v1 —
 * absence means "not captured", which keeps files small and lets values be
 * added later without a migration.
 */
export function buildTraceFile({ test, repoRoot, commitSha, recordedAt, truncated, steps }) {
  return {
    version: TRACE_FORMAT_VERSION,
    test,
    repoRoot,
    commitSha,
    recordedAt,
    truncated: truncated === true,
    steps,
  };
}

/** Encode a DAP message. Length is in *bytes* — a non-ASCII path would
 *  otherwise desync the stream. */
export function encodeDapMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

/**
 * Create a stateful reader that turns arbitrary stdout chunks into DAP
 * messages. Frames split across chunks are buffered; a frame whose body is not
 * JSON is dropped rather than stalling the stream behind it.
 */
export function createFrameReader() {
  let buffer = Buffer.alloc(0);
  return function read(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const messages = [];
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return messages;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return messages; // wait for more
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        // Malformed body: skip this frame, keep reading the next one.
      }
    }
  };
}

// ── DAP client ────────────────────────────────────────────────────────────

class DapClient {
  constructor(proc, log) {
    this.proc = proc;
    this.log = log;
    this.seq = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    const read = createFrameReader();
    proc.stdout.on("data", (chunk) => {
      for (const msg of read(chunk)) this.dispatch(msg);
    });
  }

  dispatch(msg) {
    this.log("<<", msg.type, msg.command ?? msg.event ?? "");
    if (msg.type === "response") {
      const pending = this.pending.get(msg.request_seq);
      if (!pending) return;
      this.pending.delete(msg.request_seq);
      clearTimeout(pending.timer);
      if (msg.success) pending.resolve(msg.body ?? {});
      else pending.reject(new Error(`${msg.command}: ${msg.message ?? "request failed"}`));
    } else if (msg.type === "event") {
      this.eventWaiters = this.eventWaiters.filter((w) => {
        if (w.event !== msg.event) return true;
        clearTimeout(w.timer);
        w.resolve(msg.body ?? {});
        return false;
      });
    }
  }

  request(command, args = {}) {
    const seq = this.seq++;
    this.log(">>", command);
    this.proc.stdin.write(encodeDapMessage({ seq, type: "request", command, arguments: args }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(seq)) reject(new Error(`${command}: timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(seq, { resolve, reject, timer });
    });
  }

  waitFor(event, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const waiter = { event, resolve };
      waiter.timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for '${event}'`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const valueOf = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    test: valueOf("--test", null),
    out: valueOf("--out", null),
    maxSteps: Number(valueOf("--steps", String(DEFAULT_MAX_STEPS))),
    manifestDir: path.resolve(valueOf("--manifest-dir", "src-tauri")),
    repoRoot: path.resolve(valueOf("--repo-root", ".")),
    verbose: argv.includes("--verbose"),
  };
}

function resolveLldbDap() {
  try {
    return execFileSync("xcrun", ["-f", "lldb-dap"], { encoding: "utf8" }).trim();
  } catch {
    // Fall back to PATH so Linux (and a non-Xcode macOS) still work.
    try {
      return execFileSync("which", ["lldb-dap"], { encoding: "utf8" }).trim();
    } catch {
      throw new Error(
        "lldb-dap not found. On macOS install Xcode or the Command Line Tools; " +
          "elsewhere install LLDB and put lldb-dap on PATH.",
      );
    }
  }
}

function currentCommitSha(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function record(opts, logStatus) {
  if (!opts.test) throw new Error("--test <name> is required (e.g. --test pty::tests::resolves_shell)");

  const log = opts.verbose ? (...m) => console.error("[dap]", ...m) : () => {};

  logStatus(`building test binary in ${opts.manifestDir} …`);
  const cargoOut = execFileSync("cargo", ["test", "--no-run", "--message-format=json"], {
    cwd: opts.manifestDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const exe = selectTestExecutable(cargoOut);
  logStatus(`test binary: ${exe}`);

  const adapter = resolveLldbDap();
  logStatus(`adapter: ${adapter}`);

  const proc = spawn(adapter, [], { stdio: ["pipe", "pipe", "inherit"] });
  const dap = new DapClient(proc, log);

  const steps = [];
  let truncated = false;

  try {
    await dap.request("initialize", {
      clientID: "workstreams",
      adapterID: "lldb",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
    });

    // `--exact` avoids running neighbouring tests whose frames would
    // interleave; `--test-threads=1` makes the step order deterministic.
    const launched = dap.request("launch", {
      program: exe,
      args: ["--exact", opts.test, "--test-threads=1", "--nocapture"],
      cwd: opts.manifestDir,
      stopOnEntry: false,
      env: { RUST_BACKTRACE: "0" },
    });

    // Breaking on the *function* avoids having to know which line the test
    // body starts on.
    const bp = await dap.request("setFunctionBreakpoints", {
      breakpoints: [{ name: opts.test }],
    });
    if (Array.isArray(bp.breakpoints) && bp.breakpoints.every((b) => b.verified === false)) {
      throw new Error(
        `no breakpoint could be set on '${opts.test}'. Check the test name — ` +
          "it must be fully qualified, e.g. `pty::tests::resolves_shell`.",
      );
    }
    await dap.request("configurationDone", {});
    await launched;

    logStatus("waiting for the test to be entered …");
    const stopped = await dap.waitFor("stopped");
    const threadId = stopped.threadId ?? 1;

    for (let i = 0; i < opts.maxSteps; i++) {
      let frames;
      try {
        // `levels: 0` asks for the whole stack. lldb-dap only reports a correct
        // frame count that way — with `levels: 1` its `totalFrames` is a stale
        // constant — and the count is what makes "step out" exact.
        const st = await dap.request("stackTrace", { threadId, startFrame: 0, levels: 0 });
        frames = st.stackFrames ?? [];
      } catch {
        break; // process exited — the test finished
      }
      if (frames.length === 0) break;

      const frame = frames[0];
      const file = frame.source?.path ?? null;
      const ours = isOurCode(file, opts.repoRoot);

      if (ours) {
        appendStep(steps, {
          file: path.relative(opts.repoRoot, path.resolve(file)),
          line: frame.line,
          function: demangle(frame.name),
          depth: frames.length,
        });
      }

      // Descend into our own code; retreat from everyone else's.
      try {
        await dap.request(ours ? "stepIn" : "stepOut", { threadId });
        await dap.waitFor("stopped", 15_000);
      } catch {
        break; // stepping ended (test returned, process exited)
      }

      if (i === opts.maxSteps - 1) truncated = true;
    }
  } finally {
    try {
      await dap.request("disconnect", { terminateDebuggee: true });
    } catch {
      /* adapter may already be gone */
    }
    proc.kill();
  }

  return buildTraceFile({
    test: opts.test,
    repoRoot: opts.repoRoot,
    commitSha: currentCommitSha(opts.repoRoot),
    recordedAt: new Date().toISOString(),
    truncated,
    steps,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const logStatus = (...m) => console.error("[trace-record]", ...m);

  const trace = await record(opts, logStatus);
  const json = JSON.stringify(trace, null, 2);

  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, json, "utf8");
    logStatus(`wrote ${trace.steps.length} steps to ${opts.out}`);
  } else {
    console.log(json);
  }

  if (trace.steps.length === 0) {
    logStatus("WARNING: no steps recorded — the test never entered code under the repo root.");
  }
  if (trace.truncated) {
    // The cap counts *debugger* steps, which includes the step-outs from
    // std/core frames that never reach the trace — so the recorded count is
    // always lower, and saying so avoids "I asked for 400 and got 157".
    logStatus(
      `WARNING: stopped at the ${opts.maxSteps}-step cap (debugger steps, ` +
        `including step-outs) so the trace is truncated; ${trace.steps.length} ` +
        `locations were recorded. Re-run with a larger --steps to see more.`,
    );
  }
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[trace-record] failed:", e.message);
    process.exitCode = 1;
  });
}
