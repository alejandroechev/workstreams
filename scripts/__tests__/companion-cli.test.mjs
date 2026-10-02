// @vitest-environment node
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const cli = path.resolve(__dirname, "..", "companion-cli.mjs");
const fixtures = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../src/companion/protocol/fixtures.json"), "utf8"),
);
const run = (...args) => execFileSync("node", [cli, ...args], { encoding: "utf8" });

describe("companion-cli", () => {
  it("signs a request exactly like the shared fixtures", () => {
    const { signature, ...request } = fixtures.vectors[0].request;
    const out = run("sign", "--secret", fixtures.secret, "--request", JSON.stringify(request));
    expect(out.trim()).toBe(signature);
  });

  it("checks a request the way the laptop would", () => {
    const request = fixtures.vectors[0].request;
    const ok = JSON.parse(run("check", "--secret", fixtures.secret, "--request", JSON.stringify(request), "--now", String(request.createdAt)));
    expect(ok).toEqual({ ok: true });
    const stale = JSON.parse(run("check", "--secret", fixtures.secret, "--request", JSON.stringify(request), "--now", String(request.createdAt + 10 * 60_000)));
    expect(stale).toEqual({ ok: false, reason: "expired" });
  });

  it("prints the pairing payload the QR code carries", () => {
    const out = JSON.parse(run("pairing", "--doc", "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh", "--secret", fixtures.secret));
    expect(out).toEqual({ v: 1, doc: "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh", secret: fixtures.secret });
  });

  it("runs the laptop scenario end to end and reports every outcome", () => {
    const report = JSON.parse(run("scenario"));
    expect(report.outcomes).toEqual({
      "load-beta": "done",
      "unsigned-create": "failed",
      "stale-create": "failed",
      "create-with-prompt": "done",
      "session-alpha": "done",
      "replayed-load-beta": "failed",
    });
    expect(report.appActions).toEqual([
      "load beta",
      "create \"Fix the docs\" in /phone/fix-the-docs",
      "load created-1",
      "session created-1: agency copilot --yolo -i \"List the files here\"",
      "session alpha: copilot --yolo -i \"Review the diff\"",
    ]);
  });

  it("explains its usage and fails on unknown commands", () => {
    const result = spawnSync("node", [cli, "nope"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage/i);
  });
});
