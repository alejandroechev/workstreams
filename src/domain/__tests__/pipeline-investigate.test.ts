import { describe, it, expect } from "vitest";
import { investigationBase, investigationBranch, investigationName, investigationPrompt } from "../pipeline-investigate";
import type { PipelineItem } from "../pipeline-inbox";

const item: PipelineItem = {
  id: "e1", pipeline_id: "w", pipeline_name: "media_components-CI", project: "SCC", run_id: 81724709,
  run_number: "20261105.3", result: "failed", branch: "release/2.4", trigger: "Scheduled",
  finished_at: "2026-11-05T08:10:44Z", url: "https://dev.azure.com/skype/SCC/_build/results?buildId=81724709",
  is_read: false, discovered_at: "now", repo: "media_components",
};

describe("pipeline investigations (mirror of the native rules)", () => {
  it("names the workstream and branch", () => {
    expect(investigationName(item)).toBe("Investigate media_components-CI #20261105.3");
    expect(investigationBranch(item)).toBe("investigate/media_components-CI-20261105.3");
    expect(investigationBranch({ ...item, pipeline_name: "My Pipeline: nightly..x" })).toBe("investigate/My-Pipeline-nightly.x-20261105.3");
  });

  it("writes the prompt with the run, the az hint and the report-only goal", () => {
    const text = investigationPrompt(item, { kind: "worktree", repo: "media_components", branch: "investigate/x", base: "origin/release/2.4" });
    for (const needle of ["media_components-CI", "SCC", "#20261105.3", "81724709", "release/2.4", "Scheduled", "2026-11-05T08:10:44Z",
      "Repo: media_components", item.url, "az pipelines runs show", "--org https://dev.azure.com/skype",
      "code, pipeline, infrastructure or flakiness", "Don't change any code", "created from origin/release/2.4"]) {
      expect(text).toContain(needle);
    }
    expect(investigationPrompt(item, { kind: "standalone", repo: "SCC/x", failure: null })).toContain("no local checkout");
    expect(investigationPrompt(item, { kind: "standalone", repo: "media_components", failure: "branch gone" }))
      .toContain("creating a worktree of media_components failed (branch gone)");
  });

  it("branches from the run's branch, but not from a non-branch ref", () => {
    expect(investigationBase(item)).toBe("origin/release/2.4");
    expect(investigationBase({ ...item, branch: "refs/pull/12/merge" })).toBeNull();
    expect(investigationBase({ ...item, branch: " " })).toBeNull();
    const fromDefault = investigationPrompt(item, { kind: "worktree", repo: "media_components", branch: "investigate/x", base: null });
    expect(fromDefault).toContain("created from the default branch; the run built release/2.4");
  });

  it("copes with no repo and a URL it can't read", () => {
    const text = investigationPrompt({ ...item, url: "not a url" }, { kind: "standalone", repo: "", failure: null });
    expect(text).toContain("Repo: none linked");
    expect(text).toContain("--org https://dev.azure.com/<organization>");
  });
});
