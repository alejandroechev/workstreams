import type { Project } from "../types";
import { describe, it, expect } from "vitest";
import { deriveWorktreeFolderName, deriveWorktreePath, basenameOf, parentDirOf, projectOwningPath } from "../worktree-path";

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

describe("projectOwningPath", () => {
  const p = (id: string, directory: string): Project => ({
    id,
    name: id,
    directory,
    git_remote: null,
    color: "#89b4fa",
    copilot_command: null,
    created_at: "",
    updated_at: "",
  });

  it("matches the repo root itself", () => {
    expect(projectOwningPath([p("a", "/Code/a")], "/Code/a")?.id).toBe("a");
  });

  it("matches a worktree nested below the repo", () => {
    // A worktree lives beside or under its repo; only accepting the exact
    // root would refuse every real worktree.
    expect(projectOwningPath([p("a", "/Code/a")], "/Code/a/worktrees/x")?.id).toBe("a");
  });

  it("ignores trailing separators and case", () => {
    expect(projectOwningPath([p("a", "/Code/a/")], "/code/A")?.id).toBe("a");
  });

  it("normalizes Windows separators", () => {
    expect(projectOwningPath([p("a", "C:\\Code\\a")], "C:/Code/a/sub")?.id).toBe("a");
  });

  it("prefers the innermost repo when one nests inside another", () => {
    const projects = [p("outer", "/Code"), p("inner", "/Code/a")];
    expect(projectOwningPath(projects, "/Code/a/sub")?.id).toBe("inner");
  });

  it("does not match a sibling with a shared prefix", () => {
    // `/Code/app-two` must not match the project at `/Code/app`.
    expect(projectOwningPath([p("a", "/Code/app")], "/Code/app-two")).toBeNull();
  });

  it("returns null for an unknown path", () => {
    expect(projectOwningPath([p("a", "/Code/a")], "/elsewhere")).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(projectOwningPath([p("a", "/Code/a")], "")).toBeNull();
  });
});
