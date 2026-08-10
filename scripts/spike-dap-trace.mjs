#!/usr/bin/env node
// @test-skip: Throwaway spike (ADR-pending). Validates lldb-dap step recording
// before any production code is written; deleted or replaced by the real
// recorder if the spike succeeds.
//
// D3/E8 SPIKE — can we record a Rust test's execution as an ordered list of
// source lines, by driving `lldb-dap` over the Debug Adapter Protocol?
//
// This answers the one question that gates the whole code-walkthrough feature.
// It is deliberately throwaway: no tests, no UI, no persistence.
//
// WHY THIS EXISTS: launching a process under a debugger failed from the agent's
// sandboxed shell ("attach failed ... could not pause execution") — macOS
// hardened-runtime/debug permissions. It must be run from a real terminal.
//
// USAGE (from a real terminal, in the repo root):
//   node scripts/spike-dap-trace.mjs
//   node scripts/spike-dap-trace.mjs --test shell_env::tests::merge_drops_empty_segments
//   node scripts/spike-dap-trace.mjs --steps 40 --verbose
//
// SUCCESS: a JSON array of {file, line, function} in execution order, made of
//          this repo's own source lines, with no std/core noise.
// KILL:    if that doesn't happen within the timebox, do NOT build the UI.

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const VERBOSE = args.includes("--verbose");

const TEST_NAME = argOf("--test", "pty::tests::default_shell_prefers_the_shell_env_var_on_unix");
const MAX_STEPS = Number(argOf("--steps", "60"));
const CARGO_DIR = path.resolve(argOf("--manifest-dir", "src-tauri"));
const REPO_ROOT = path.resolve(argOf("--repo-root", "."));

const log = (...m) => console.error("[spike]", ...m);
const vlog = (...m) => VERBOSE && console.error("[spike:dap]", ...m);

// ── 1. Build the test binary and find it ──────────────────────────────────
// `--message-format=json` gives the executable path directly, which avoids
// guessing at the hash suffix cargo appends (workstreams_lib-fa7744cd28...).
function findTestBinary() {
  log(`building test binary in ${CARGO_DIR} …`);
  const out = execFileSync("cargo", ["test", "--no-run", "--message-format=json"], {
    cwd: CARGO_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const candidates = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.profile?.test && msg.executable) {
      candidates.push({ name: msg.target?.name ?? "?", exe: msg.executable });
    }
  }
  if (candidates.length === 0) throw new Error("no test executable found in cargo output");
  // The lib test binary holds the unit tests we care about.
  const lib = candidates.find((c) => c.name.endsWith("_lib")) ?? candidates[0];
  log(`test binary: ${lib.exe}`);
  return lib.exe;
}

// ── 2. Minimal DAP client over stdio ──────────────────────────────────────
// DAP frames are `Content-Length: N\r\n\r\n<json>` — same envelope as LSP.
class DapClient {
  constructor(proc) {
    this.proc = proc;
    this.seq = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.buffer = Buffer.alloc(0);
    proc.stdout.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.subarray(start, start + len).toString("utf8");
      this.buffer = this.buffer.subarray(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    vlog("<<", msg.type, msg.command ?? msg.event ?? "", msg.success === false ? `FAILED: ${msg.message}` : "");
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (p) {
        this.pending.delete(msg.request_seq);
        msg.success ? p.resolve(msg.body ?? {}) : p.reject(new Error(`${msg.command}: ${msg.message ?? "failed"}`));
      }
    } else if (msg.type === "event") {
      this.eventWaiters = this.eventWaiters.filter((w) => {
        if (w.event !== msg.event) return true;
        w.resolve(msg.body ?? {});
        return false;
      });
    }
  }

  request(command, args = {}) {
    const seq = this.seq++;
    const payload = JSON.stringify({ seq, type: "request", command, arguments: args });
    vlog(">>", command);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(seq)) reject(new Error(`${command}: timed out after 30s`));
      }, 30_000);
    });
  }

  waitFor(event, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const waiter = { event, resolve };
      this.eventWaiters.push(waiter);
      setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        reject(new Error(`event '${event}': timed out`));
      }, timeoutMs);
    });
  }
}

// ── 3. Drive the session ──────────────────────────────────────────────────
// E2 rule: step INTO everything, but as soon as we land outside the repo,
// step OUT again. That keeps the trace proportional to *our* code while still
// recording that a std/core call happened.
function isOurCode(file) {
  if (!file) return false;
  const abs = path.resolve(file);
  return abs.startsWith(REPO_ROOT) && !abs.includes(`${path.sep}target${path.sep}`);
}

async function main() {
  const exe = findTestBinary();
  const dapPath = execFileSync("xcrun", ["-f", "lldb-dap"], { encoding: "utf8" }).trim();
  log(`lldb-dap: ${dapPath}`);
  log(`tracing test: ${TEST_NAME}`);

  const proc = spawn(dapPath, [], { stdio: ["pipe", "pipe", "inherit"] });
  const dap = new DapClient(proc);

  const caps = await dap.request("initialize", {
    clientID: "workstreams-spike",
    adapterID: "lldb",
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: "path",
  });
  log("adapter capabilities:",
      `stepInTargets=${!!caps.supportsStepInTargetsRequest}`,
      `configDone=${!!caps.supportsConfigurationDoneRequest}`);

  // --test-threads=1 keeps the trace deterministic and single-threaded;
  // --exact avoids running neighbours whose frames would interleave.
  const launched = dap.request("launch", {
    program: exe,
    args: ["--exact", TEST_NAME, "--test-threads=1", "--nocapture"],
    cwd: CARGO_DIR,
    stopOnEntry: false,
    env: { RUST_BACKTRACE: "0" },
  });

  // Break on the test function itself. A function breakpoint avoids having to
  // know which line the test starts on.
  await dap.request("setFunctionBreakpoints", {
    breakpoints: [{ name: TEST_NAME }],
  });
  await dap.request("configurationDone", {});
  await launched;

  log("waiting for first stop …");
  const stopped = await dap.waitFor("stopped");
  const threadId = stopped.threadId ?? 1;
  log(`stopped (${stopped.reason}) on thread ${threadId}`);

  const steps = [];
  let stepsOut = 0;

  for (let i = 0; i < MAX_STEPS; i++) {
    let frames;
    try {
      const st = await dap.request("stackTrace", { threadId, startFrame: 0, levels: 1 });
      frames = st.stackFrames ?? [];
    } catch {
      break; // process gone
    }
    if (frames.length === 0) break;

    const f = frames[0];
    const file = f.source?.path ?? null;
    const ours = isOurCode(file);

    if (ours) {
      const step = {
        file: path.relative(REPO_ROOT, file),
        line: f.line,
        function: (f.name ?? "?").split("::h")[0],
      };
      // Collapse consecutive duplicates. A line like
      //   Some(s) if s.trim().starts_with('/')
      // makes several std calls; each time we step in and immediately step
      // back out we land on that same line again. Those are debugger
      // mechanics, not execution history — recording them would show the
      // reader "line 154" eight times in a row. A genuine revisit (a loop)
      // still registers, because control returns via a *different* line
      // first.
      const prev = steps[steps.length - 1];
      const isRepeat = prev && prev.file === step.file && prev.line === step.line
        && prev.function === step.function;
      if (isRepeat) {
        prev.hits = (prev.hits ?? 1) + 1;
      } else {
        steps.push(step);
      }
    }

    // The E2 rule in one line: descend into our own code, retreat from theirs.
    const command = ours ? "stepIn" : "stepOut";
    if (!ours) stepsOut++;

    try {
      await dap.request(command, { threadId });
      await dap.waitFor("stopped", 15_000);
    } catch (e) {
      log(`stepping ended: ${e.message}`);
      break;
    }
  }

  try { await dap.request("disconnect", { terminateDebuggee: true }); } catch { /* ignore */ }
  proc.kill();

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log(JSON.stringify(steps, null, 2));

  const distinctLines = new Set(steps.map((s) => `${s.file}:${s.line}`)).size;
  log("");
  log(`recorded ${steps.length} steps (${distinctLines} distinct lines), ${stepsOut} step-outs from foreign frames`);
  if (steps.length === 0) {
    log("RESULT: ❌ KILL — no steps recorded. See the errors above.");
    process.exitCode = 1;
  } else {
    log("RESULT: ✅ PASS — ordered source lines captured. Feature is viable.");
  }
}

main().catch((e) => {
  log("FAILED:", e.message);
  log("RESULT: ❌ KILL (unless this is a fixable setup issue)");
  process.exitCode = 1;
});
