import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureShowcaseFiles, SAMPLE_MD } from "../dev-seed.mjs";

// Isolated dir so tests never collide with a running dev pwsh holding
// .dev/showcase as cwd (Windows locks dir until child process exits).
const TEST_DIR = path.join(os.tmpdir(), `ws-seed-test-${process.pid}`);
const README = path.join(TEST_DIR, "README.md");

describe("dev-seed", () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates the showcase folder and README.md when missing", () => {
    ensureShowcaseFiles(TEST_DIR);
    expect(fs.existsSync(README)).toBe(true);
    expect(fs.readFileSync(README, "utf8")).toContain("Mermaid diagram");
  });

  it("does not overwrite an existing README.md (idempotent)", () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(README, "user content");
    ensureShowcaseFiles(TEST_DIR);
    expect(fs.readFileSync(README, "utf8")).toBe("user content");
  });

  it("SAMPLE_MD covers all the rendering features under test", () => {
    expect(SAMPLE_MD).toContain("```mermaid");
    expect(SAMPLE_MD).toContain("```typescript");
    expect(SAMPLE_MD).toContain("> A blockquote");
    expect(SAMPLE_MD).toMatch(/\| Column A/);
  });
});
