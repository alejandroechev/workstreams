import { describe, it, expect } from "vitest";

import { groupTestsByModule, filterTests, moduleOf, shortTestName } from "../test-picker";

const TESTS = [
  "pty::tests::resolves_shell",
  "pty::tests::default_shell",
  "shell_env::tests::merge_paths",
  "code_review::git::tests::resolve_base_ref",
  "top_level_test",
];

describe("moduleOf", () => {
  it("drops the test name, keeping the module path", () => {
    expect(moduleOf("pty::tests::resolves_shell")).toBe("pty::tests");
    expect(moduleOf("code_review::git::tests::resolve_base_ref")).toBe("code_review::git::tests");
  });

  it("groups an unqualified test under a stable placeholder", () => {
    // A bare name has no module; it still needs a group so it can be found.
    expect(moduleOf("top_level_test")).toBe("(root)");
  });
});

describe("shortTestName", () => {
  it("keeps only the final segment, which is what distinguishes tests in a group", () => {
    expect(shortTestName("pty::tests::resolves_shell")).toBe("resolves_shell");
    expect(shortTestName("top_level_test")).toBe("top_level_test");
  });
});

describe("groupTestsByModule", () => {
  it("groups tests under their module, sorted for stable ordering", () => {
    const groups = groupTestsByModule(TESTS);
    expect(groups.map((g) => g.module)).toEqual([
      "(root)",
      "code_review::git::tests",
      "pty::tests",
      "shell_env::tests",
    ]);
    expect(groups.find((g) => g.module === "pty::tests")?.tests).toEqual([
      "pty::tests::default_shell",
      "pty::tests::resolves_shell",
    ]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupTestsByModule([])).toEqual([]);
  });
});

describe("filterTests", () => {
  it("returns everything for a blank query", () => {
    expect(filterTests(TESTS, "")).toHaveLength(TESTS.length);
    expect(filterTests(TESTS, "   ")).toHaveLength(TESTS.length);
  });

  it("matches case-insensitively on any part of the path", () => {
    expect(filterTests(TESTS, "SHELL")).toEqual([
      "pty::tests::resolves_shell",
      "pty::tests::default_shell",
      "shell_env::tests::merge_paths",
    ]);
  });

  it("narrows by module so a crate or file can be scoped first", () => {
    // The point of the feature: 258 tests is unusable, but "shell_env" is 12.
    expect(filterTests(TESTS, "shell_env")).toEqual(["shell_env::tests::merge_paths"]);
  });

  it("matches every whitespace-separated term, in any order", () => {
    // Lets the user narrow by module *and* name without recalling the exact
    // path — "pty shell" finds pty::tests::resolves_shell.
    expect(filterTests(TESTS, "pty shell")).toEqual([
      "pty::tests::resolves_shell",
      "pty::tests::default_shell",
    ]);
    expect(filterTests(TESTS, "shell pty")).toHaveLength(2);
  });

  it("returns nothing when a term matches nothing", () => {
    expect(filterTests(TESTS, "pty nonexistent")).toEqual([]);
  });

  it("preserves input order so grouping stays predictable", () => {
    expect(filterTests(TESTS, "tests")[0]).toBe("pty::tests::resolves_shell");
  });
});
