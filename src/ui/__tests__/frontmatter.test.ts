import { describe, it, expect } from "vitest";
import { extractFrontmatter } from "../frontmatter";

describe("extractFrontmatter", () => {
  it("returns the source unchanged when no frontmatter block is present", () => {
    const r = extractFrontmatter("# hello\nworld");
    expect(r.hasFrontmatter).toBe(false);
    expect(r.fields).toEqual([]);
    expect(r.body).toBe("# hello\nworld");
  });

  it("parses a minimal frontmatter + body", () => {
    const src = `---
name: code-grok
description: short description
---
# Body
hello`;
    const r = extractFrontmatter(src);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.fields).toEqual([
      { key: "name", value: "code-grok" },
      { key: "description", value: "short description" },
    ]);
    expect(r.body).toBe("# Body\nhello");
  });

  it("preserves dashes/underscores/digits in keys", () => {
    const src = `---
file-name: x
ver_2: y
abc123: z
---
body`;
    const r = extractFrontmatter(src);
    expect(r.fields.map((f) => f.key)).toEqual(["file-name", "ver_2", "abc123"]);
  });

  it("joins continuation lines (indented) into the previous value", () => {
    const src = `---
description: line one
  line two
  line three
name: x
---
body`;
    const r = extractFrontmatter(src);
    expect(r.fields).toEqual([
      { key: "description", value: "line one line two line three" },
      { key: "name", value: "x" },
    ]);
  });

  it("returns unchanged when frontmatter is not closed", () => {
    const src = `---
name: x
no closing fence ever
# body that looks like content`;
    const r = extractFrontmatter(src);
    expect(r.hasFrontmatter).toBe(false);
    expect(r.body).toBe(src);
  });

  it("requires '---' to be at byte 0", () => {
    const src = `intro paragraph
---
name: x
---
body`;
    const r = extractFrontmatter(src);
    expect(r.hasFrontmatter).toBe(false);
  });

  it("normalizes CRLF input", () => {
    const src = "---\r\nname: x\r\n---\r\nbody";
    const r = extractFrontmatter(src);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.fields).toEqual([{ key: "name", value: "x" }]);
    expect(r.body).toBe("body");
  });

  it("skips blank lines inside the block", () => {
    const src = `---
name: x

description: y
---
body`;
    const r = extractFrontmatter(src);
    expect(r.fields).toEqual([
      { key: "name", value: "x" },
      { key: "description", value: "y" },
    ]);
  });
});
