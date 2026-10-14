// @vitest-environment node
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve(__dirname, "..", "acceptance-cli.mjs");
const fixture = path.resolve(__dirname, "../../src/domain/acceptance/__tests__/fixtures/new-format.md");
const old = path.resolve(__dirname, "../../src/domain/acceptance/__tests__/fixtures/old-format.md");
const run = (...args) => spawnSync("node", [cli, ...args], { encoding: "utf8" });
const copy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-"));
  const file = path.join(dir, "acceptance.md");
  fs.copyFileSync(fixture, file);
  return file;
};

describe("acceptance-cli", () => {
  it("parses tests, marks and frames into JSON", () => {
    const out = JSON.parse(run("parse", fixture).stdout);
    expect(out.status).toBe("draft");
    expect(out.missing).toEqual(["nothing checks undo"]);
    expect(out.tests.map((t) => [t.id, t.review?.kind ?? null, t.frames.length])).toEqual([
      ["AT-1", "ok", 3], ["AT-2", "change", 0], ["AT-3", null, 0],
    ]);
    expect(out.tests[0].lines).toBeUndefined();
  });

  it("marks, clears, notes a missing test and requests a visual", () => {
    const file = copy();
    expect(run("mark", file, "AT-3", "change", "too", "vague").status).toBe(0);
    expect(run("mark", file, "AT-1", "clear").status).toBe(0);
    expect(run("missing", file, "nothing", "checks", "redo").status).toBe(0);
    expect(run("request", file, "AT-2", "the error state").status).toBe(0);
    const out = JSON.parse(run("parse", file).stdout);
    expect(out.tests.map((t) => t.review)).toEqual([null, { kind: "change", note: "also check the exit code" }, { kind: "change", note: "too vague" }]);
    expect(out.missing).toEqual(["nothing checks undo", "nothing checks redo"]);
    expect(out.tests[1].visualRequests).toContain("the error state");
  });

  it("keeps a CRLF file CRLF throughout", () => {
    const file = copy();
    fs.writeFileSync(file, fs.readFileSync(fixture, "utf8").replace(/\n/g, "\r\n"));
    expect(run("mark", file, "AT-3", "ok").status).toBe(0);
    expect(run("missing", file, "x").status).toBe(0);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("**Review:** ok\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("refuses to edit a file with mixed line endings, leaving it untouched", () => {
    const file = copy();
    const mixed = fs.readFileSync(fixture, "utf8").replace("\n", "\r\n");
    fs.writeFileSync(file, mixed);
    const refused = run("mark", file, "AT-3", "ok");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("mixes CRLF and LF");
    expect(fs.readFileSync(file, "utf8")).toBe(mixed);
  });

  it("refuses to change an approved file, and explains bad usage", () => {
    const refused = run("mark", old, "AT-1", "ok");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("approved");
    expect(run("mark", copy(), "AT-1", "maybe").status).toBe(2);
    expect(run("bogus").status).toBe(2);
  });
});
