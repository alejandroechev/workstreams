import { describe, it, expect } from "vitest";

import {
  diffFileCommentable,
  diffModeEditable,
  EDITABLE_DIFF_MODE,
} from "../diff-edit";

describe("diffModeEditable", () => {
  it("allows editing the unstaged diff, whose modified side is the working file", () => {
    expect(diffModeEditable("unstaged")).toBe(true);
  });

  describe("diffFileCommentable", () => {
    it("allows comments on working files in the unstaged diff", () => {
      expect(diffFileCommentable("unstaged", "A")).toBe(true);
      expect(diffFileCommentable("unstaged", "M")).toBe(true);
      expect(diffFileCommentable("unstaged", "R")).toBe(true);
    });

    it("refuses deleted files and historical modes", () => {
      expect(diffFileCommentable("unstaged", "D")).toBe(false);
      expect(diffFileCommentable("last_commit", "M")).toBe(false);
      expect(diffFileCommentable("branch_vs_master", "M")).toBe(false);
      expect(diffFileCommentable("custom_branch", "M")).toBe(false);
      expect(diffFileCommentable("unstaged", undefined)).toBe(false);
    });
  });

  it("refuses historical diffs, whose modified side is a git object", () => {
    // `last_commit` compares HEAD~1 against HEAD, and `branch_vs_master`
    // compares master against HEAD. Neither modified side exists on disk, so
    // there is nothing an edit could be written back to.
    expect(diffModeEditable("last_commit")).toBe(false);
    expect(diffModeEditable("branch_vs_master")).toBe(false);
    expect(diffModeEditable("custom_branch")).toBe(false);
  });

  it("refuses an absent or unknown mode rather than defaulting to editable", () => {
    // Failing closed matters: a new diff mode added later must not silently
    // become writable before anyone has checked where its modified side
    // comes from.
    expect(diffModeEditable(null)).toBe(false);
    expect(diffModeEditable(undefined)).toBe(false);
    expect(diffModeEditable("something_new")).toBe(false);
  });

  it("names the editable mode so callers need not hardcode the string", () => {
    expect(EDITABLE_DIFF_MODE).toBe("unstaged");
    expect(diffModeEditable(EDITABLE_DIFF_MODE)).toBe(true);
  });
});
