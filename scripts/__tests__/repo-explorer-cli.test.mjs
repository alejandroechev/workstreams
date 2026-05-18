import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const cli = path.resolve(__dirname, "..", "repo-explorer-cli.mjs");

describe("repo-explorer-cli", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rxs-cli-"));
    fs.mkdirSync(path.join(tmp, "node_modules", "junk"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules", "junk", "skip.txt"), "needle");
    fs.writeFileSync(path.join(tmp, "alpha.txt"), "Hello World\nanother line\n");
    fs.writeFileSync(path.join(tmp, "beta.md"), "nothing here\nwOrLd peace\n");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finds content matches case-insensitively and skips node_modules", () => {
    const out = execSync(`node "${cli}" "${tmp}" "world"`, { encoding: "utf8" });
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.includes("alpha.txt:1:"))).toBe(true);
    expect(lines.some((l) => l.includes("beta.md:2:"))).toBe(true);
    expect(out.includes("node_modules")).toBe(false);
  });

  it("supports --names for filename-only search", () => {
    const out = execSync(`node "${cli}" "${tmp}" "alpha" --names`, { encoding: "utf8" });
    expect(out.trim()).toMatch(/alpha\.txt$/);
  });

  it("respects --limit", () => {
    fs.writeFileSync(path.join(tmp, "c.txt"), "world\nworld\nworld\n");
    const out = execSync(`node "${cli}" "${tmp}" "world" --limit 2`, { encoding: "utf8" });
    expect(out.trim().split("\n").length).toBe(2);
  });
});
