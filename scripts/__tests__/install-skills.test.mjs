// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { install, skillNames } from "../install-skills.mjs";

const script = path.resolve(__dirname, "..", "install-skills.mjs");
const repoSkill = path.resolve(__dirname, "../../skills/companion-reply/SKILL.md");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));

describe("install-skills", () => {
  it("ships the companion-reply skill with every instruction it needs", () => {
    expect(skillNames()).toContain("companion-reply");
    const text = fs.readFileSync(repoSkill, "utf8");
    expect(text).toMatch(/^---\nname: companion-reply\n/);
    for (const needle of ["kind=result", "kind=progress", "text=@-", "in the terminal", "NOT_A_PHONE_SESSION", "COMPANION_OFF", "20000", "$WORKSTREAMS_SOCKET"]) {
      expect(text).toContain(needle);
    }
  });

  it("copies every skill byte for byte, and reports up-to-date on a second run", () => {
    const dest = tmp();
    expect(install({ dest }).find((r) => r.name === "companion-reply").status).toBe("installed");
    expect(fs.readFileSync(path.join(dest, "companion-reply", "SKILL.md")).equals(fs.readFileSync(repoSkill))).toBe(true);
    expect(install({ dest }).every((r) => r.status === "up-to-date")).toBe(true);
  });

  it("--check reports a stale copy without touching it", () => {
    const dest = tmp();
    fs.mkdirSync(path.join(dest, "companion-reply"), { recursive: true });
    fs.writeFileSync(path.join(dest, "companion-reply", "SKILL.md"), "old");
    const result = spawnSync("node", [script, "--dest", dest, "--check"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).find((r) => r.name === "companion-reply").status).toBe("differs");
    expect(fs.readFileSync(path.join(dest, "companion-reply", "SKILL.md"), "utf8")).toBe("old");
    execFileSync("node", [script, "--dest", dest]);
    expect(spawnSync("node", [script, "--dest", dest, "--check"]).status).toBe(0);
  });
});
