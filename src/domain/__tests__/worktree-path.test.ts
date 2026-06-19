import { describe, it, expect } from "vitest";
import { deriveWorktreeFolderName, deriveWorktreePath, basenameOf, parentDirOf } from "../worktree-path";

describe("deriveWorktreeFolderName", () => {
  it("prefixes the repo name onto the branch suffix", () => {
    expect(deriveWorktreeFolderName("workstreams", "feature-x")).toBe("workstreams-feature-x");
  });

  it("uses only the last path segment of the branch", () => {
    expect(deriveWorktreeFolderName("workstreams", "alejandroe/feature-x")).toBe("workstreams-feature-x");
  });

  it("does not double-prefix when the branch already starts with '<repo>-'", () => {
    expect(deriveWorktreeFolderName("workstreams", "workstreams-feature-x")).toBe("workstreams-feature-x");
  });

  it("falls back to the bare branch suffix when there is no repo name", () => {
    expect(deriveWorktreeFolderName(null, "alejandroe/feature-x")).toBe("feature-x");
    expect(deriveWorktreeFolderName("", "feature-x")).toBe("feature-x");
  });
});

describe("basenameOf / parentDirOf", () => {
  it("returns the last path segment (Windows + POSIX)", () => {
    expect(basenameOf("C:\\repos\\workstreams")).toBe("workstreams");
    expect(basenameOf("/home/me/repos/workstreams")).toBe("workstreams");
    expect(basenameOf("C:\\repos\\workstreams\\")).toBe("workstreams");
  });

  it("returns the parent directory, preserving separator style", () => {
    expect(parentDirOf("C:\\repos\\workstreams")).toBe("C:\\repos");
    expect(parentDirOf("/home/me/repos/workstreams")).toBe("/home/me/repos");
    expect(parentDirOf("C:\\repos\\workstreams\\")).toBe("C:\\repos");
  });
});

describe("deriveWorktreePath", () => {
  it("places the worktree as a sibling of the project dir, repo-prefixed", () => {
    expect(deriveWorktreePath("C:\\repos\\workstreams", "alejandroe/feature-x")).toBe(
      "C:\\repos\\workstreams-feature-x",
    );
  });

  it("uses an explicit repo name when provided (overrides basename)", () => {
    expect(deriveWorktreePath("C:\\repos\\ws-clone", "feature-x", "workstreams")).toBe(
      "C:\\repos\\workstreams-feature-x",
    );
  });

  it("works with POSIX separators", () => {
    expect(deriveWorktreePath("/home/me/repos/workstreams", "feature-x")).toBe(
      "/home/me/repos/workstreams-feature-x",
    );
  });
});
