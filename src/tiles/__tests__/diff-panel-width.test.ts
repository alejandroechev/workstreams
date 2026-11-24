import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DIFF_PANEL_WIDTH,
  MIN_DIFF_PANEL_WIDTH,
  MIN_DIFF_VIEWER_WIDTH,
  clampDiffPanelWidth,
  loadDiffPanelWidth,
  saveDiffPanelWidth,
} from "../diff-panel-width";

describe("clampDiffPanelWidth", () => {
  it("keeps a width inside the allowed range unchanged", () => {
    expect(clampDiffPanelWidth(300, 1000)).toBe(300);
  });

  it("never shrinks the file list below its minimum", () => {
    expect(clampDiffPanelWidth(20, 1000)).toBe(MIN_DIFF_PANEL_WIDTH);
  });

  it("always leaves room for the code viewer", () => {
    expect(clampDiffPanelWidth(950, 1000)).toBe(1000 - MIN_DIFF_VIEWER_WIDTH);
  });

  it("prefers the file-list minimum when the container is too narrow for both", () => {
    expect(clampDiffPanelWidth(500, 200)).toBe(MIN_DIFF_PANEL_WIDTH);
  });

  it("only applies the minimum when the container width is unknown", () => {
    expect(clampDiffPanelWidth(900, 0)).toBe(900);
  });

  it("rounds to whole pixels", () => {
    expect(clampDiffPanelWidth(250.6, 1000)).toBe(251);
  });
});

describe("diff panel width persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults when nothing is stored", () => {
    expect(loadDiffPanelWidth()).toBe(DEFAULT_DIFF_PANEL_WIDTH);
  });

  it("round-trips a saved width", () => {
    saveDiffPanelWidth(320);
    expect(loadDiffPanelWidth()).toBe(320);
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem("workstreams.repoExplorer.diffFileListWidth", "wide");
    expect(loadDiffPanelWidth()).toBe(DEFAULT_DIFF_PANEL_WIDTH);
  });

  it("raises a stored value below the minimum", () => {
    localStorage.setItem("workstreams.repoExplorer.diffFileListWidth", "10");
    expect(loadDiffPanelWidth()).toBe(MIN_DIFF_PANEL_WIDTH);
  });
});
