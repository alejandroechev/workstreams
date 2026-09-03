import { describe, it, expect } from "vitest";
import {
  normalizeVersion,
  parseChangelog,
  sectionFor,
} from "../changelog-section.mjs";

const SAMPLE = `# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- A thing that is not shipped yet.

## [0.8.0] - 2026-09-10

### Added

- Generated keyboard shortcut reference.

### Fixed

- Wrapped terminal input no longer loses its first row.

## [0.7.0] - 2026-09-03

### Changed

- Restructured the README.

[unreleased]: https://github.com/o/r/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/o/r/compare/v0.7.0...v0.8.0
`;

describe("normalizeVersion", () => {
  it("strips a single leading v so tag and heading forms compare equal", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("V1.2.3")).toBe("1.2.3");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeVersion("  v0.1.0 ")).toBe("0.1.0");
  });

  it("tolerates nullish input", () => {
    expect(normalizeVersion(undefined)).toBe("");
    expect(normalizeVersion(null)).toBe("");
  });
});

describe("parseChangelog", () => {
  it("finds every bracketed version section in document order", () => {
    expect(parseChangelog(SAMPLE).map((s) => s.version)).toEqual([
      "Unreleased",
      "0.8.0",
      "0.7.0",
    ]);
  });

  it("captures the release date when present and null otherwise", () => {
    const [unreleased, latest] = parseChangelog(SAMPLE);
    expect(unreleased.date).toBeNull();
    expect(latest.date).toBe("2026-09-10");
  });

  it("excludes link-reference definitions from the last section body", () => {
    const last = parseChangelog(SAMPLE).at(-1);
    expect(last.body).not.toContain("https://github.com/o/r/compare");
    expect(last.body).toContain("Restructured the README.");
  });

  it("returns an empty list for a document with no sections", () => {
    expect(parseChangelog("# Changelog\n\nNothing here.\n")).toEqual([]);
  });

  it("tolerates nullish input", () => {
    expect(parseChangelog(undefined)).toEqual([]);
  });
});

describe("sectionFor", () => {
  it("returns the body for a matching version", () => {
    const body = sectionFor(SAMPLE, "0.8.0");
    expect(body).toContain("Generated keyboard shortcut reference.");
    expect(body).toContain("Wrapped terminal input");
  });

  it("matches a v-prefixed tag against an unprefixed heading", () => {
    expect(sectionFor(SAMPLE, "v0.8.0")).toBe(sectionFor(SAMPLE, "0.8.0"));
  });

  it("does not bleed the next version's content into the previous section", () => {
    expect(sectionFor(SAMPLE, "0.8.0")).not.toContain("Restructured the README.");
  });

  it("returns null for a version that has no section", () => {
    expect(sectionFor(SAMPLE, "9.9.9")).toBeNull();
  });

  it("returns null for a section that exists but is empty", () => {
    const empty = "# Changelog\n\n## [0.2.0] - 2026-01-01\n\n## [0.1.0] - 2025-12-01\n\n- shipped\n";
    expect(sectionFor(empty, "0.2.0")).toBeNull();
    expect(sectionFor(empty, "0.1.0")).toContain("shipped");
  });
});
