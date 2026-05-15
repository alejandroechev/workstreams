import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ensureShowcaseFiles, SAMPLE_MD, SHOWCASE_DIR } from "../dev-seed.mjs";

const README = path.join(SHOWCASE_DIR, "README.md");

describe("dev-seed", () => {
  beforeEach(() => {
    fs.rmSync(SHOWCASE_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(SHOWCASE_DIR, { recursive: true, force: true });
  });

  it("creates the showcase folder and README.md when missing", () => {
    ensureShowcaseFiles();
    expect(fs.existsSync(README)).toBe(true);
    expect(fs.readFileSync(README, "utf8")).toContain("Mermaid diagram");
  });

  it("does not overwrite an existing README.md (idempotent)", () => {
    fs.mkdirSync(SHOWCASE_DIR, { recursive: true });
    fs.writeFileSync(README, "user content");
    ensureShowcaseFiles();
    expect(fs.readFileSync(README, "utf8")).toBe("user content");
  });

  it("SAMPLE_MD covers all the rendering features under test", () => {
    expect(SAMPLE_MD).toContain("```mermaid");
    expect(SAMPLE_MD).toContain("```typescript");
    expect(SAMPLE_MD).toContain("> A blockquote");
    expect(SAMPLE_MD).toMatch(/\| Column A/);
  });
});
