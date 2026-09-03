import { describe, it, expect } from "vitest";
import { parseFrontMatter, validateAdrs, ALLOWED_STATUSES, REQUIRE_FRONT_MATTER } from "../check-adrs.mjs";

const INDEX = `## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-alpha.md) | Alpha | Accepted |
| [002](002-beta.md) | Beta | Superseded |
| [003](003-gamma.md) | Gamma | Accepted |
`;

function adr(name, fm) {
  const body = fm
    ? `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# Title\n`
    : `# Title\n\nNo front matter here.\n`;
  return { name, text: body };
}

describe("parseFrontMatter", () => {
  it("returns null when the file has no front-matter block", () => {
    expect(parseFrontMatter("# ADR 001\n\nSome prose.\n")).toBeNull();
  });

  it("parses the delimited block at the very top into fields", () => {
    const parsed = parseFrontMatter("---\nid: \"001\"\nstatus: Accepted\ndate: 2026-01-15\n---\n\n# Title\n");
    expect(parsed).toEqual({ id: "001", status: "Accepted", date: "2026-01-15" });
  });

  it("ignores a --- fence that is not at the very top", () => {
    expect(parseFrontMatter("# Title\n\n---\nid: \"001\"\n---\n")).toBeNull();
  });
});

describe("validateAdrs", () => {
  it("exposes the allowed status vocabulary", () => {
    expect(ALLOWED_STATUSES).toEqual(["Accepted", "Retired", "Rewritten", "Superseded"]);
  });

  it("accepts a fully valid ADR record", () => {
    const files = [adr("001-alpha.md", { id: '"001"', status: "Accepted", date: "2026-01-15" })];
    expect(validateAdrs({ files, indexText: INDEX })).toEqual([]);
  });

  it("accepts a valid superseded_by pointing at an existing ADR", () => {
    const files = [
      adr("002-beta.md", { id: '"002"', status: "Superseded", date: "2026-02-01", superseded_by: '"003"' }),
      adr("003-gamma.md", { id: '"003"', status: "Accepted", date: "2026-02-02" }),
    ];
    expect(validateAdrs({ files, indexText: INDEX })).toEqual([]);
  });

  it("reports a status outside the vocabulary", () => {
    const files = [adr("001-alpha.md", { id: '"001"', status: "Draft", date: "2026-01-15" })];
    const errors = validateAdrs({ files, indexText: INDEX });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("001-alpha.md");
    expect(errors[0]).toMatch(/status/i);
    expect(errors[0]).toContain("Draft");
  });

  it("reports a malformed date", () => {
    const bad = ["2026-13-01", "not-a-date", "2026-02-30", "26-01-01"];
    for (const date of bad) {
      const files = [adr("001-alpha.md", { id: '"001"', status: "Accepted", date })];
      const errors = validateAdrs({ files, indexText: INDEX });
      expect(errors, `expected ${date} to be rejected`).toHaveLength(1);
      expect(errors[0]).toMatch(/date/i);
    }
  });

  it("reports a superseded_by naming a non-existent ADR", () => {
    const files = [
      adr("002-beta.md", { id: '"002"', status: "Superseded", date: "2026-02-01", superseded_by: '"099"' }),
    ];
    const errors = validateAdrs({ files, indexText: INDEX });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/superseded_by/i);
    expect(errors[0]).toContain("099");
  });

  it("reports an id that does not match the filename prefix", () => {
    const files = [adr("001-alpha.md", { id: '"002"', status: "Accepted", date: "2026-01-15" })];
    const errors = validateAdrs({ files, indexText: INDEX });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/id/i);
  });

  it("reports an ADR missing from the README index table", () => {
    const files = [adr("004-delta.md", { id: '"004"', status: "Accepted", date: "2026-03-01" })];
    const errors = validateAdrs({ files, indexText: INDEX });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/index/i);
  });

  it("skips files with no front matter while the tolerance flag is off", () => {
    expect(REQUIRE_FRONT_MATTER).toBe(false);
    // 004-delta.md is not in the index either — still no error, because it is skipped entirely.
    const files = [adr("001-alpha.md", null), adr("004-delta.md", null)];
    expect(validateAdrs({ files, indexText: INDEX })).toEqual([]);
  });
});
