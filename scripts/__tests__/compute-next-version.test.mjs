import { describe, it, expect } from "vitest";
import {
  classifyCommit,
  selectBump,
  parseTag,
  formatTag,
  computeNextVersion,
  BUMP_NONE, BUMP_PATCH, BUMP_MINOR, BUMP_MAJOR,
} from "../compute-next-version.mjs";

describe("classifyCommit", () => {
  it("feat: → minor", () => {
    expect(classifyCommit("feat: add tile-grid keyboard nav")).toBe(BUMP_MINOR);
    expect(classifyCommit("feat(repo): include untracked files")).toBe(BUMP_MINOR);
  });

  it("fix:, perf:, refactor:, chore:, test:, style:, build:, ci:, revert: → patch", () => {
    for (const t of ["fix", "perf", "refactor", "chore", "test", "style", "build", "ci", "revert"]) {
      expect(classifyCommit(`${t}: tweak something`)).toBe(BUMP_PATCH);
      expect(classifyCommit(`${t}(scope): tweak something`)).toBe(BUMP_PATCH);
    }
  });

  it("docs: → none", () => {
    expect(classifyCommit("docs: update README")).toBe(BUMP_NONE);
    expect(classifyCommit("docs(adr): add ADR 009")).toBe(BUMP_NONE);
  });

  it("trailing ! marks a breaking change → major", () => {
    expect(classifyCommit("feat!: drop legacy API")).toBe(BUMP_MAJOR);
    expect(classifyCommit("fix(backend)!: rewrite tile persistence")).toBe(BUMP_MAJOR);
    expect(classifyCommit("chore!: bump min Node to 22")).toBe(BUMP_MAJOR);
  });

  it("BREAKING CHANGE: in body marks a breaking change → major", () => {
    expect(classifyCommit("feat: do thing\n\nBREAKING CHANGE: removes old API")).toBe(BUMP_MAJOR);
    expect(classifyCommit("fix: stuff\n\nbreaking change: case-insensitive ok")).toBe(BUMP_MAJOR);
  });

  it("unknown / unprefixed messages default to patch", () => {
    expect(classifyCommit("just a freeform message")).toBe(BUMP_PATCH);
    expect(classifyCommit("WIP something")).toBe(BUMP_PATCH);
  });

  it("handles empty input safely", () => {
    expect(classifyCommit("")).toBe(BUMP_PATCH);
    expect(classifyCommit("   \n   ")).toBe(BUMP_PATCH);
  });
});

describe("selectBump", () => {
  it("picks the strongest bump in the range", () => {
    expect(selectBump(["fix: a", "feat: b", "docs: c"])).toBe(BUMP_MINOR);
    expect(selectBump(["fix: a", "feat!: b", "docs: c"])).toBe(BUMP_MAJOR);
    expect(selectBump(["docs: a", "docs: b"])).toBe(BUMP_NONE);
    expect(selectBump(["fix: a", "fix: b"])).toBe(BUMP_PATCH);
  });

  it("empty input is no bump", () => {
    expect(selectBump([])).toBe(BUMP_NONE);
  });
});

describe("parseTag", () => {
  it("accepts v-prefix and bare semver", () => {
    expect(parseTag("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseTag("0.10.5")).toEqual([0, 10, 5]);
  });
  it("returns null for invalid input", () => {
    expect(parseTag(null)).toBeNull();
    expect(parseTag("")).toBeNull();
    expect(parseTag("v1.2")).toBeNull();
    expect(parseTag("v1.2.3-rc.4")).toBeNull(); // pure semver only
    expect(parseTag("garbage")).toBeNull();
  });
});

describe("formatTag", () => {
  it("emits v-prefixed", () => {
    expect(formatTag(1, 2, 3)).toBe("v1.2.3");
  });
});

describe("computeNextVersion", () => {
  it("first release (no prior tag) returns the fallback as-is for any non-docs bump", () => {
    expect(computeNextVersion(null, ["feat: launch"], { fallback: "v0.1.0" }))
      .toEqual({ tag: "v0.1.0", bump: BUMP_MINOR });
    expect(computeNextVersion(null, ["fix: tiny patch"], { fallback: "v0.1.0" }))
      .toEqual({ tag: "v0.1.0", bump: BUMP_PATCH });
    expect(computeNextVersion(null, ["feat!: breaking initial"], { fallback: "v0.1.0" }))
      .toEqual({ tag: "v0.1.0", bump: BUMP_MAJOR });
  });

  it("first release with only docs returns null", () => {
    expect(computeNextVersion(null, ["docs: README"], { fallback: "v0.1.0" })).toBeNull();
  });

  it("subsequent feat: bumps minor", () => {
    expect(computeNextVersion("v0.1.0", ["feat: new tile"]))
      .toEqual({ tag: "v0.2.0", bump: BUMP_MINOR });
  });

  it("subsequent fix: bumps patch", () => {
    expect(computeNextVersion("v0.1.0", ["fix: window close"]))
      .toEqual({ tag: "v0.1.1", bump: BUMP_PATCH });
  });

  it("breaking change bumps major and resets minor + patch", () => {
    expect(computeNextVersion("v1.4.7", ["feat!: rewrite"]))
      .toEqual({ tag: "v2.0.0", bump: BUMP_MAJOR });
  });

  it("minor bump resets patch", () => {
    expect(computeNextVersion("v1.4.7", ["feat: x"]))
      .toEqual({ tag: "v1.5.0", bump: BUMP_MINOR });
  });

  it("docs-only commits return null (skip release)", () => {
    expect(computeNextVersion("v1.4.7", ["docs: tutorial", "docs: README"])).toBeNull();
  });

  it("strongest bump wins across the range", () => {
    expect(computeNextVersion("v0.1.0", ["fix: a", "feat: b", "docs: c"]))
      .toEqual({ tag: "v0.2.0", bump: BUMP_MINOR });
  });

  it("empty commit list returns null", () => {
    expect(computeNextVersion("v0.1.0", [])).toBeNull();
  });

  it("uses fallback when lastTag is unparseable", () => {
    expect(computeNextVersion("not-a-tag", ["feat: x"], { fallback: "v0.1.0" }))
      .toEqual({ tag: "v0.1.0", bump: BUMP_MINOR });
  });

  it("respects custom fallback", () => {
    expect(computeNextVersion(null, ["feat: x"], { fallback: "v1.0.0" }))
      .toEqual({ tag: "v1.0.0", bump: BUMP_MINOR });
  });
});
