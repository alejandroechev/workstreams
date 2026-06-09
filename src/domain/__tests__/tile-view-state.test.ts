import { describe, it, expect } from "vitest";
import { parseViewState, mergeViewState } from "../tile-view-state";

describe("parseViewState", () => {
  it("returns empty object for null/undefined/empty input", () => {
    expect(parseViewState(null, "repo_explorer")).toEqual({});
    expect(parseViewState(undefined, "repo_explorer")).toEqual({});
    expect(parseViewState("", "repo_explorer")).toEqual({});
  });

  it("returns empty object for malformed JSON", () => {
    expect(parseViewState("{ not json", "repo_explorer")).toEqual({});
  });

  it("returns empty object when there is no viewState sub-key", () => {
    expect(parseViewState(JSON.stringify({ cwd: "C:\\repo" }), "repo_explorer")).toEqual({});
  });

  it("returns the viewState sub-object for repo_explorer", () => {
    const config = JSON.stringify({
      cwd: "C:\\repo",
      viewState: {
        activeTab: "diff",
        currentDir: "C:\\repo\\src",
        filePath: "C:\\repo\\src\\foo.ts",
        diffMode: "vs_master",
        hookName: "pre-commit",
        mdViewMode: "edit",
      },
    });
    expect(parseViewState(config, "repo_explorer")).toEqual({
      activeTab: "diff",
      currentDir: "C:\\repo\\src",
      filePath: "C:\\repo\\src\\foo.ts",
      diffMode: "vs_master",
      hookName: "pre-commit",
      mdViewMode: "edit",
    });
  });

  it("filters unknown fields per tile kind", () => {
    const config = JSON.stringify({
      viewState: {
        activeTab: "files",
        viewingPath: "ignored-for-repo-explorer",
        dbTable: "also-ignored",
      },
    });
    expect(parseViewState(config, "repo_explorer")).toEqual({ activeTab: "files" });
  });

  it("drops empty strings", () => {
    const config = JSON.stringify({
      viewState: { activeTab: "", currentDir: "C:\\repo" },
    });
    expect(parseViewState(config, "repo_explorer")).toEqual({ currentDir: "C:\\repo" });
  });

  it("rejects invalid mdViewMode values", () => {
    const config = JSON.stringify({
      viewState: { mdViewMode: "garbage" },
    });
    expect(parseViewState(config, "repo_explorer")).toEqual({});
  });

  it("repo_explorer accepts split/unified diffLayout and rejects others", () => {
    expect(parseViewState(
      JSON.stringify({ viewState: { diffLayout: "split" } }),
      "repo_explorer",
    )).toEqual({ diffLayout: "split" });
    expect(parseViewState(
      JSON.stringify({ viewState: { diffLayout: "unified" } }),
      "repo_explorer",
    )).toEqual({ diffLayout: "unified" });
    expect(parseViewState(
      JSON.stringify({ viewState: { diffLayout: "weird" } }),
      "repo_explorer",
    )).toEqual({});
  });

  it("session_meta picks tab/file/dbTable", () => {
    const config = JSON.stringify({
      viewState: { activeTab: "database", filePath: "x.md", dbTable: "todos" },
    });
    expect(parseViewState(config, "session_meta")).toEqual({
      activeTab: "database",
      filePath: "x.md",
      dbTable: "todos",
    });
  });

  it("workbench picks only viewingPath", () => {
    const config = JSON.stringify({
      viewState: { viewingPath: "C:\\a.ts", activeTab: "ignored" },
    });
    expect(parseViewState(config, "workbench")).toEqual({ viewingPath: "C:\\a.ts" });
  });

  it("plan picks tab + selectedHistoryPlanId + historySubTab", () => {
    const config = JSON.stringify({
      viewState: { activeTab: "history", selectedHistoryPlanId: "p1", historySubTab: "todos" },
    });
    expect(parseViewState(config, "plan")).toEqual({
      activeTab: "history",
      selectedHistoryPlanId: "p1",
      historySubTab: "todos",
    });
  });
});

describe("mergeViewState", () => {
  it("creates viewState sub-object on empty config", () => {
    const out = mergeViewState(null, "repo_explorer", { activeTab: "files" });
    expect(JSON.parse(out)).toEqual({ viewState: { activeTab: "files" } });
  });

  it("preserves existing top-level config fields", () => {
    const before = JSON.stringify({ cwd: "C:\\repo", command: "pwsh.exe" });
    const out = mergeViewState(before, "repo_explorer", { activeTab: "diff" });
    expect(JSON.parse(out)).toEqual({
      cwd: "C:\\repo",
      command: "pwsh.exe",
      viewState: { activeTab: "diff" },
    });
  });

  it("replaces existing viewState (not merges field by field)", () => {
    const before = JSON.stringify({
      viewState: { activeTab: "files", filePath: "x.ts" },
    });
    const out = mergeViewState(before, "repo_explorer", { activeTab: "diff" });
    // filePath dropped — caller is expected to pass the FULL desired viewState
    expect(JSON.parse(out)).toEqual({ viewState: { activeTab: "diff" } });
  });

  it("drops undefined and null fields from the new viewState", () => {
    const out = mergeViewState(
      "{}",
      "repo_explorer",
      // @ts-expect-error — intentional shape check for runtime sanitization
      { activeTab: "files", filePath: undefined, hookName: null },
    );
    expect(JSON.parse(out)).toEqual({ viewState: { activeTab: "files" } });
  });

  it("treats malformed input config as empty base", () => {
    const out = mergeViewState("{not json", "repo_explorer", { activeTab: "files" });
    expect(JSON.parse(out)).toEqual({ viewState: { activeTab: "files" } });
  });

  it("treats non-object parsed input (e.g. array) as empty base", () => {
    const out = mergeViewState("[1,2,3]", "repo_explorer", { activeTab: "files" });
    expect(JSON.parse(out)).toEqual({ viewState: { activeTab: "files" } });
  });
});

describe("parseViewState edge cases", () => {
  it("returns empty when parsed JSON is not an object (e.g. array)", () => {
    expect(parseViewState("[1,2]", "repo_explorer")).toEqual({});
  });

  it("plan: rejects unknown historySubTab values", () => {
    const config = JSON.stringify({
      viewState: { historySubTab: "bogus" },
    });
    expect(parseViewState(config, "plan")).toEqual({});
  });
});

describe("round trip", () => {
  it("parse(merge(...)) returns the input viewState (per-kind sanitized)", () => {
    const before = JSON.stringify({ cwd: "C:\\repo" });
    const out = mergeViewState(before, "repo_explorer", {
      activeTab: "diff",
      diffMode: "unstaged",
      mdViewMode: "preview",
    });
    expect(parseViewState(out, "repo_explorer")).toEqual({
      activeTab: "diff",
      diffMode: "unstaged",
      mdViewMode: "preview",
    });
  });
});
