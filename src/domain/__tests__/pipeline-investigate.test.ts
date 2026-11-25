import { describe, it, expect } from "vitest";
import {
  batchBranchName,
  batchPrompt,
  batchWorkstreamName,
  CONCLUSION_INSTRUCTION,
  followupPrompt,
  investigationBase,
  investigationBranch,
  investigationName,
  investigationPrompt,
} from "../pipeline-investigate";
import type { PipelineItem } from "../pipeline-inbox";
import type { PipelineDigest } from "../pipeline-digest";

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
    const pr = { ...item, branch: "refs/pull/12/merge" };
    const fromDefault = investigationPrompt(pr, { kind: "worktree", repo: "media_components", branch: "investigate/x", base: "origin/main" });
    expect(fromDefault).toContain("created from origin/main (the default branch); the run built refs/pull/12/merge");
  });

  it("copes with no repo and a URL it can't read", () => {
    const text = investigationPrompt({ ...item, url: "not a url" }, { kind: "standalone", repo: "", failure: null });
    expect(text).toContain("Repo: none linked");
    expect(text).toContain("--org https://dev.azure.com/<organization>");
  });
});

describe("investigating a daily digest as one batch", () => {
  const digest: PipelineDigest = {
    id: "d1", pipeline_id: "p1", pipeline_name: "CI Main: nightly", project: "SCC", organization: "skype", repo: null,
    window_start: "2026-03-01T12:00:00Z", window_end: "2026-03-02T12:00:00Z", total: 12, failed: 2, state: "passed_since",
    runs: [12, 3].map((id) => ({ run_id: id, run_number: `2026.${id}`, branch: "main", trigger: "CI", finished_at: "2026-03-01T13:00:00Z",
      commit: id === 3 ? "" : `sha${id}`, url: `https://dev.azure.com/skype/SCC/_build/results?buildId=${id}`, step: id === 12 ? "Run tests" : null,
      step_state: "fetched" as const, investigation: null })),
    is_read: false, created_at: "2026-03-02T12:00:00.000Z", investigation: null, auto_pending: false,
  };

  it("names its branch and workstream after the pipeline and the digest's day", () => {
    expect(batchBranchName(digest)).toBe("investigate/CI-Main-nightly-failures-20260302");
    expect(batchWorkstreamName(digest)).toBe("Investigate CI Main: nightly failures 2026-03-02");
  });

  it("lists every failed run and asks to group, label, change nothing and report to the Inbox", () => {
    const text = batchPrompt(digest, { kind: "worktree", repo: "mc", branch: "investigate/x", base: "origin/main" });
    expect(text).toContain("2 of 12 runs failed between 2026-03-01T12:00:00Z and 2026-03-02T12:00:00Z; the newest run passed since.");
    expect(text).toContain('- #2026.12 (id 12), branch main, commit sha12, finished 2026-03-01T13:00:00Z, failing step "Run tests": https://dev.azure.com/skype/SCC/_build/results?buildId=12');
    expect(text).toContain("- #2026.3 (id 3), branch main, commit unknown");
    expect(text).toContain("created from origin/main (the default branch's tip)");
    expect(text).toContain("Change nothing until I ask");
    expect(text).toContain(CONCLUSION_INSTRUCTION);
    expect(batchPrompt(digest, { kind: "standalone", repo: "", failure: null })).toContain("Repo: none linked");
  });

  it("sends an existing investigation only the new runs, with the same rules", () => {
    const text = followupPrompt(digest);
    expect(text).toMatch(/^A new daily digest of CI Main: nightly \(project SCC\): 2 of 12 runs failed/);
    expect(text).toContain("buildId=12");
    expect(text).toContain("Change nothing until I ask");
    expect(text).toContain(CONCLUSION_INSTRUCTION);
  });
});
