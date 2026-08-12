import { describe, it, expect } from "vitest";

import {
  selectTestExecutable,
  isOurCode,
  appendStep,
  buildTraceFile,
  encodeDapMessage,
  createFrameReader,
  demangle,
  adapterKindFor,
  stackTraceLevels,
  functionBreakpointRegex,
} from "../trace-record.mjs";

describe("Windows adapter support", () => {
  it("classifies an adapter by its executable name", () => {
    expect(adapterKindFor("/usr/bin/lldb-dap")).toBe("lldb-dap");
    expect(adapterKindFor("C:\\Program Files\\LLVM\\bin\\lldb-dap.exe")).toBe("lldb-dap");
    expect(
      adapterKindFor("C:\\Users\\me\\.vscode\\extensions\\vadimcn.vscode-lldb-1.11.4\\adapter\\codelldb.exe"),
    ).toBe("codelldb");
    // Unknown adapters get the conservative dialect, whose requests are also
    // valid for lldb-dap.
    expect(adapterKindFor("/opt/some-dap")).toBe("codelldb");
  });

  it("asks codelldb for a finite stack depth", () => {
    // The DAP spec says `levels: 0` means "all frames" and lldb-dap obeys, so
    // the frame count is exact. codelldb takes 0 literally and returns ZERO
    // frames, which recorded an empty trace with no error at all.
    expect(stackTraceLevels("lldb-dap")).toBe(0);
    expect(stackTraceLevels("codelldb")).toBeGreaterThanOrEqual(200);
  });

  it("anchors a function-breakpoint regex to the end of the symbol", () => {
    // Neither setFunctionBreakpoints nor `breakpoint set --name` resolves a
    // Rust symbol read from a PDB; a regex does. `$` keeps the breakpoint off
    // the `::{{closure}}` twin that shares the prefix.
    expect(functionBreakpointRegex("tests::classifies_and_sums")).toBe("tests::classifies_and_sums$");
  });

  it("escapes regex metacharacters in a test path", () => {
    const escaped = functionBreakpointRegex("mod::conv<T>::works+fast");
    expect(escaped.startsWith("mod::conv<T>::works\\+fast")).toBe(true);
    expect(escaped.endsWith("$")).toBe(true);
  });

  it("strips MSVC decoration from a frame name", () => {
    // LLDB reads MSVC PDBs and reports C++-style signatures rather than the
    // Rust path it yields from DWARF.
    expect(demangle("struct ref$<str$> traceprobe::classify(int)")).toBe("traceprobe::classify");
    expect(demangle("int traceprobe::sum_evens(struct ref$<slice2$<i32> >)")).toBe("traceprobe::sum_evens");
    // A plain Rust path must survive untouched.
    expect(demangle("traceprobe::tests::classifies_and_sums")).toBe("traceprobe::tests::classifies_and_sums");
  });
});

describe("selectTestExecutable", () => {
  const line = (o) => JSON.stringify(o);

  it("picks the executable cargo reports for a test target", () => {
    const stdout = [
      line({ reason: "compiler-artifact", target: { name: "serde" }, profile: { test: false }, executable: null }),
      line({ reason: "compiler-artifact", target: { name: "workstreams_lib" }, profile: { test: true }, executable: "/t/deps/workstreams_lib-abc" }),
    ].join("\n");
    expect(selectTestExecutable(stdout)).toBe("/t/deps/workstreams_lib-abc");
  });

  it("prefers the lib test binary when several exist", () => {
    // `cargo test` builds one binary per target; unit tests live in the lib
    // one, so picking the first would often trace the wrong binary.
    const stdout = [
      line({ target: { name: "workstreams" }, profile: { test: true }, executable: "/t/deps/workstreams-bin" }),
      line({ target: { name: "workstreams_lib" }, profile: { test: true }, executable: "/t/deps/workstreams_lib-abc" }),
    ].join("\n");
    expect(selectTestExecutable(stdout)).toBe("/t/deps/workstreams_lib-abc");
  });

  it("ignores non-JSON noise interleaved by cargo", () => {
    const stdout = [
      "   Compiling workstreams v0.2.0",
      line({ target: { name: "workstreams_lib" }, profile: { test: true }, executable: "/t/x" }),
      "    Finished `test` profile",
    ].join("\n");
    expect(selectTestExecutable(stdout)).toBe("/t/x");
  });

  it("throws an actionable error when no test binary was produced", () => {
    expect(() => selectTestExecutable("")).toThrow(/no test executable/i);
    expect(() => selectTestExecutable(line({ target: { name: "x" }, profile: { test: false } })))
      .toThrow(/no test executable/i);
  });
});

describe("isOurCode", () => {
  const root = "/Users/me/repo";

  it("accepts files under the repo root", () => {
    expect(isOurCode("/Users/me/repo/src-tauri/src/pty.rs", root)).toBe(true);
  });

  it("rejects std/core frames outside the repo", () => {
    // This is the step-out trigger: without it a trivial assert descends into
    // thousands of frames of formatting machinery.
    expect(isOurCode("/rustc/abc/library/core/src/ops/function.rs", root)).toBe(false);
    expect(isOurCode("/usr/lib/whatever.rs", root)).toBe(false);
  });

  it("rejects generated code under target/", () => {
    expect(isOurCode("/Users/me/repo/target/debug/build/out.rs", root)).toBe(false);
  });

  it("rejects a missing source path", () => {
    // DAP omits `source.path` for frames with no debug info.
    expect(isOurCode(null, root)).toBe(false);
    expect(isOurCode(undefined, root)).toBe(false);
    expect(isOurCode("", root)).toBe(false);
  });

  it("does not treat a sibling directory with the same prefix as inside", () => {
    expect(isOurCode("/Users/me/repo-other/src/x.rs", root)).toBe(false);
  });
});

describe("appendStep", () => {
  const step = (line, fn = "f", file = "a.rs") => ({ file, line, function: fn });

  it("appends distinct locations in order", () => {
    const steps = [];
    appendStep(steps, step(1));
    appendStep(steps, step(2));
    expect(steps.map((s) => s.line)).toEqual([1, 2]);
  });

  it("collapses consecutive identical locations into a hits count", () => {
    // A line making std calls returns to itself after every step-out. Those
    // repeats are debugger mechanics, not execution history.
    const steps = [];
    appendStep(steps, step(154));
    appendStep(steps, step(154));
    appendStep(steps, step(154));
    expect(steps).toHaveLength(1);
    expect(steps[0].hits).toBe(3);
  });

  it("omits hits entirely when a location was recorded once", () => {
    const steps = [];
    appendStep(steps, step(1));
    expect("hits" in steps[0]).toBe(false);
  });

  it("preserves loop revisits", () => {
    // 52 -> 53 -> 52 is a real loop iteration; only *consecutive* duplicates
    // are mechanics. Collapsing these would erase the execution order that is
    // the entire point of the feature.
    const steps = [];
    for (const l of [52, 53, 52, 53, 52]) appendStep(steps, step(l));
    expect(steps.map((s) => s.line)).toEqual([52, 53, 52, 53, 52]);
  });

  it("does not collapse the same line in a different function", () => {
    // Same line number in a different file/function is a different location;
    // recursion and macro expansion make this real.
    const steps = [];
    appendStep(steps, step(10, "outer"));
    appendStep(steps, step(10, "inner"));
    expect(steps).toHaveLength(2);
  });

  it("does not collapse the same line in a different file", () => {
    const steps = [];
    appendStep(steps, step(10, "f", "a.rs"));
    appendStep(steps, step(10, "f", "b.rs"));
    expect(steps).toHaveLength(2);
  });
});

describe("demangle", () => {
  it("strips the rustc hash suffix", () => {
    expect(demangle("workstreams_lib::pty::resolve_unix_shell::h883e38d7c33f09e0"))
      .toBe("workstreams_lib::pty::resolve_unix_shell");
  });

  it("leaves an unmangled name alone", () => {
    expect(demangle("main")).toBe("main");
  });

  it("survives a missing name", () => {
    expect(demangle(null)).toBe("");
    expect(demangle(undefined)).toBe("");
  });
});

describe("buildTraceFile", () => {
  it("produces a version-1 file with the recorded metadata", () => {
    const trace = buildTraceFile({
      test: "a::b",
      repoRoot: "/r",
      commitSha: "abc123",
      recordedAt: "2026-01-01T00:00:00.000Z",
      truncated: false,
      steps: [{ file: "a.rs", line: 1, function: "f" }],
    });
    expect(trace.version).toBe(1);
    expect(trace.test).toBe("a::b");
    expect(trace.truncated).toBe(false);
    expect(trace.steps).toHaveLength(1);
  });

  it("marks a capped recording as truncated", () => {
    // A silent cut would make the reader believe execution ended early.
    const trace = buildTraceFile({
      test: "a::b", repoRoot: "/r", commitSha: "s", recordedAt: "t",
      truncated: true, steps: [],
    });
    expect(trace.truncated).toBe(true);
  });

  it("never emits a vars field in v1", () => {
    const trace = buildTraceFile({
      test: "a::b", repoRoot: "/r", commitSha: "s", recordedAt: "t",
      truncated: false, steps: [{ file: "a.rs", line: 1, function: "f" }],
    });
    expect("vars" in trace.steps[0]).toBe(false);
  });
});

describe("DAP framing", () => {
  it("encodes a message with a byte-accurate Content-Length", () => {
    const encoded = encodeDapMessage({ seq: 1, type: "request", command: "next" });
    const [header, body] = encoded.split("\r\n\r\n");
    expect(Number(/Content-Length: (\d+)/.exec(header)[1])).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("measures length in bytes, not characters", () => {
    // A non-ASCII path in an argument would desync the stream if we used
    // string length.
    const encoded = encodeDapMessage({ path: "/tmp/café/ünïcode" });
    const [header, body] = encoded.split("\r\n\r\n");
    const declared = Number(/Content-Length: (\d+)/.exec(header)[1]);
    expect(declared).toBe(Buffer.byteLength(body, "utf8"));
    expect(declared).toBeGreaterThan(body.length);
  });

  it("reads a single complete frame", () => {
    const read = createFrameReader();
    const out = read(Buffer.from(encodeDapMessage({ seq: 1, hello: "world" }), "utf8"));
    expect(out).toEqual([{ seq: 1, hello: "world" }]);
  });

  it("reassembles a frame split across chunks", () => {
    // stdout arrives in arbitrary chunks; a naive parser loses messages here.
    const read = createFrameReader();
    const full = Buffer.from(encodeDapMessage({ seq: 7, command: "stackTrace" }), "utf8");
    expect(read(full.subarray(0, 12))).toEqual([]);
    expect(read(full.subarray(12, 30))).toEqual([]);
    expect(read(full.subarray(30))).toEqual([{ seq: 7, command: "stackTrace" }]);
  });

  it("returns several frames delivered in one chunk", () => {
    const read = createFrameReader();
    const buf = Buffer.from(
      encodeDapMessage({ seq: 1 }) + encodeDapMessage({ seq: 2 }) + encodeDapMessage({ seq: 3 }),
      "utf8",
    );
    expect(read(buf).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("skips a frame whose body is not JSON without stalling the stream", () => {
    const read = createFrameReader();
    const bad = "Content-Length: 3\r\n\r\n{{{";
    const good = encodeDapMessage({ seq: 9 });
    expect(read(Buffer.from(bad + good, "utf8"))).toEqual([{ seq: 9 }]);
  });
});
