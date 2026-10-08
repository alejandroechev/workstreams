// @vitest-environment node
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve(__dirname, "..", "grill-cli.mjs");
const fixture = path.resolve(__dirname, "../../src/domain/grill/__tests__/fixtures/new-format.md");
const run = (...args) => spawnSync("node", [cli, ...args], { encoding: "utf8" });
const copy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grill-"));
  const file = path.join(dir, "grill-me.md");
  fs.copyFileSync(fixture, file);
  return file;
};

describe("grill-cli", () => {
  it("parses a grill into JSON", () => {
    const out = JSON.parse(run("parse", fixture).stdout);
    expect(out.editableRound).toBe(2);
    expect(out.questions.map((q) => `${q.round}:${q.id}:${q.importance}`)).toEqual([
      "1:A1:High", "1:A2:Low", "1:Z1:Low", "2:A1:Blocking", "2:A2:Medium", "2:A3:Medium",
    ]);
  });

  it("answers a question in place, and refuses reco on Blocking", () => {
    const file = copy();
    expect(run("answer", file, "A1", "b").status).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toContain("**Answer:** b\n");
    const refused = run("answer", file, "A1", "reco");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Blocking");
  });

  it("finishes a round: preview, refusal, then defaults", () => {
    const file = copy();
    const refused = run("finish", file);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("A1");
    run("answer", file, "A1", "a");
    expect(JSON.parse(run("finish", file, "--preview").stdout)).toEqual({ defaulted: ["A3"], written: false });
    expect(JSON.parse(run("finish", file).stdout)).toEqual({ defaulted: ["A3"], written: true });
    expect(fs.readFileSync(file, "utf8")).toContain("**Answer:** reco (default — not reviewed)");
  });
});
