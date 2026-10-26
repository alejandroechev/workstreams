import { describe, it, expect } from "vitest";
import {
  countUnreadInbox,
  groupPipelineItems,
  isPipelineMode,
  parsePipelineLink,
  pipelineModeWatches,
  resultLabel,
  type PipelineItem,
} from "../pipeline-inbox";
import type { PrInboxItem } from "../pr-inbox";

const item = (over: Partial<PipelineItem>): PipelineItem => ({
  id: "e", pipeline_id: "p", pipeline_name: "Nightly", project: "SCC", run_id: 1, run_number: "1",
  result: "failed", branch: "main", trigger: "Scheduled", finished_at: "2026-10-26T08:00:00Z",
  url: "https://dev.azure.com/o/SCC/_build/results?buildId=1", is_read: false, discovered_at: "2026-10-26T08:01:00Z",
  ...over,
});

describe("pipeline modes", () => {
  it("watch only failed or succeeded runs, per mode", () => {
    const table = (["off", "failures", "successes", "both"] as const).map((mode) =>
      ["failed", "succeeded", "partiallySucceeded", "canceled"].map((r) => pipelineModeWatches(mode, r)));
    expect(table).toEqual([
      [false, false, false, false],
      [true, false, false, false],
      [false, true, false, false],
      [true, true, false, false],
    ]);
    expect(isPipelineMode("both")).toBe(true);
    expect(isPipelineMode("sometimes")).toBe(false);
  });

  it("names results the way the inbox shows them", () => {
    expect(["failed", "succeeded", "partiallySucceeded", "canceled", "weird"].map(resultLabel))
      .toEqual(["Failed", "Succeeded", "Partially succeeded", "Canceled", "weird"]);
  });
});

describe("pipeline links", () => {
  it("reads run and pipeline links in both host forms", () => {
    expect(parsePipelineLink("https://dev.azure.com/skype/SCC/_build/results?buildId=81724709&view=logs"))
      .toEqual({ organization: "skype", project: "SCC", target: { kind: "run", id: 81724709 } });
    expect(parsePipelineLink(" https://skype.visualstudio.com/My%20Proj/_build?definitionId=33770 "))
      .toEqual({ organization: "skype", project: "My Proj", target: { kind: "definition", id: 33770 } });
  });

  it("refuses anything else", () => {
    for (const bad of [
      "https://github.com/o/r/actions/runs/1",
      "https://dev.azure.com/skype/SCC/_git/r/pullrequest/5",
      "http://dev.azure.com/skype/SCC/_build?definitionId=1",
      "https://dev.azure.com/skype/SCC/_build?definitionId=x",
      "https://a.b.visualstudio.com/SCC/_build?definitionId=1",
      "nope",
    ]) expect(parsePipelineLink(bad)).toBeNull();
  });
});

describe("grouping pipeline notifications", () => {
  it("groups by pipeline, newest run first, newest pipeline first", () => {
    const groups = groupPipelineItems([
      item({ id: "a1", pipeline_id: "a", pipeline_name: "Weekly", run_id: 1, finished_at: "2026-10-19T08:00:00Z", is_read: true }),
      item({ id: "b1", pipeline_id: "b", pipeline_name: "Watchdog", run_id: 5, finished_at: "2026-10-26T07:00:00Z" }),
      item({ id: "a2", pipeline_id: "a", pipeline_name: "Weekly", run_id: 2, finished_at: "2026-10-26T08:00:00Z", is_read: true }),
      item({ id: "b2", pipeline_id: "b", pipeline_name: "Watchdog", run_id: 6, finished_at: "2026-10-26T19:00:00Z" }),
    ]);
    expect(groups.map((g) => [g.pipeline_id, g.unread, g.items.map((i) => i.id)])).toEqual([
      ["b", true, ["b2", "b1"]],
      ["a", false, ["a2", "a1"]],
    ]);
    expect(groups[0]).toMatchObject({ pipeline_name: "Watchdog", project: "SCC" });
  });
});

describe("the Inbox badge", () => {
  it("counts unread PRs (not events) plus unread pipeline runs", () => {
    const pr = (id: string, pr_id: number, is_read: boolean) => ({ id, project_id: "r", pr_id, is_read }) as PrInboxItem;
    expect(countUnreadInbox({
      items: [pr("1", 7, false), pr("2", 7, false), pr("3", 8, true)],
      pipeline_items: [item({ id: "x" }), item({ id: "y" }), item({ id: "z", is_read: true })],
    })).toBe(3);
    expect(countUnreadInbox({ items: [] })).toBe(0);
  });
});
