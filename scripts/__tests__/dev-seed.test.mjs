import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureShowcaseFiles,
  SAMPLE_LOOP_YAML,
  SAMPLE_MD,
} from "../dev-seed-files.mjs";

// Isolated dir so tests never collide with a running dev pwsh holding
// .dev/showcase as cwd (Windows locks dir until child process exits).
const TEST_DIR = path.join(os.tmpdir(), `ws-seed-test-${process.pid}`);
const README = path.join(TEST_DIR, "README.md");
const LOOP_DEFINITION = path.join(
  TEST_DIR,
  "session-state",
  "files",
  "loops",
  "showcase.loop.yaml",
);

describe("dev-seed", () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates the showcase files when missing", () => {
    ensureShowcaseFiles(TEST_DIR, path.dirname(LOOP_DEFINITION));
    expect(fs.existsSync(README)).toBe(true);
    expect(fs.readFileSync(README, "utf8")).toContain("Mermaid diagram");
    expect(fs.readFileSync(LOOP_DEFINITION, "utf8")).toBe(SAMPLE_LOOP_YAML);
  });

  it("does not overwrite existing showcase files (idempotent)", () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(README, "user content");
    fs.mkdirSync(path.dirname(LOOP_DEFINITION), { recursive: true });
    fs.writeFileSync(LOOP_DEFINITION, "user loop");
    ensureShowcaseFiles(TEST_DIR, path.dirname(LOOP_DEFINITION));
    expect(fs.readFileSync(README, "utf8")).toBe("user content");
    expect(fs.readFileSync(LOOP_DEFINITION, "utf8")).toBe("user loop");
  });

  it("SAMPLE_MD covers all the rendering features under test", () => {
    expect(SAMPLE_MD).toContain("```mermaid");
    expect(SAMPLE_MD).toContain("```typescript");
    expect(SAMPLE_MD).toContain("> A blockquote");
    expect(SAMPLE_MD).toMatch(/\| Column A/);
    expect(SAMPLE_LOOP_YAML).toContain("id: showcase-loop");
    expect(SAMPLE_LOOP_YAML).toContain("evaluator:");
    expect(SAMPLE_LOOP_YAML).toContain("humanApproval:");
  });
});
