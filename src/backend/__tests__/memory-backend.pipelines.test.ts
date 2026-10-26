import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

const RUN = "https://dev.azure.com/skype/SCC/_build/results?buildId=81723251&view=logs";
const PAGE = "https://skype.visualstudio.com/SCC/_build?definitionId=33770";

function backend() {
  const b = new MemoryBackend();
  b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 33770, name: "agency_pipeline_watchdog",
    runs: [{ id: 81723251, number: "81723251", result: "failed", finished_at: "2026-10-26T07:06:15Z" }] });
  b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 33995, name: "Agency NgcServer Update" });
  return b;
}

describe("MemoryBackend pipelines", () => {
  it("adds a pipeline from a run link, once, with its last result and Failures mode", async () => {
    const b = backend();
    const added = await b.addPipelineWatch(RUN);
    expect(added).toMatchObject({ name: "agency_pipeline_watchdog", project: "SCC", mode: "failures", last_result: "failed", last_run_number: "81723251" });
    await expect(b.addPipelineWatch(PAGE)).rejects.toThrow("Already watching");
    expect((await b.getPrInbox()).pipelines).toHaveLength(1);
    expect((await b.getPrInbox()).pipeline_items).toEqual([]);
  });

  it("refuses bad, unknown and unauthenticated links", async () => {
    const b = backend();
    await expect(b.addPipelineWatch("https://github.com/o/r/actions/runs/1")).rejects.toThrow("pipeline or run link");
    await expect(b.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=1")).rejects.toThrow("wasn't found");
    b.setPipelineAuthError(true);
    await expect(b.addPipelineWatch(PAGE)).rejects.toThrow("az login");
    expect((await b.getPrInbox()).pipelines).toEqual([]);
  });

  it("notifies finished runs by mode, changes mode, reads and removes", async () => {
    const b = backend();
    const p = await b.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=33995", "both");
    b.finishPipelineRun(p.id, { id: 1, number: "1", result: "failed", branch: "main", trigger: "Scheduled", finished_at: "2100-10-27T08:00:00Z" });
    b.finishPipelineRun(p.id, { id: 2, number: "2", result: "canceled", branch: "main", trigger: "Manual · Ana", finished_at: "2100-10-27T09:00:00Z" });
    b.finishPipelineRun(p.id, { id: 1, number: "1", result: "failed", branch: "main", trigger: "Scheduled", finished_at: "2100-10-27T08:00:00Z" });
    let inbox = await b.getPrInbox();
    expect(inbox.pipeline_items!.map((i) => [i.run_id, i.result, i.url])).toEqual([
      [1, "failed", "https://dev.azure.com/skype/SCC/_build/results?buildId=1"],
    ]);
    expect(inbox.pipelines![0]).toMatchObject({ last_result: "canceled", last_run_number: "2" });
    await b.setPrInboxRead(inbox.pipeline_items![0].id, true);
    await b.setPipelineWatchMode(p.id, "off");
    b.finishPipelineRun(p.id, { id: 3, number: "3", result: "failed", branch: "main", trigger: "CI", finished_at: "2100-10-27T10:00:00Z" });
    inbox = await b.getPrInbox();
    expect(inbox.pipelines![0].mode).toBe("off");
    expect(inbox.pipeline_items!.map((i) => [i.run_id, i.is_read])).toEqual([[1, true]]);
    await b.removePipelineWatch(p.id);
    inbox = await b.getPrInbox();
    expect([inbox.pipelines, inbox.pipeline_items]).toEqual([[], []]);
    await expect(b.removePipelineWatch(p.id)).rejects.toThrow();
    await expect(b.setPipelineWatchMode(p.id, "both")).rejects.toThrow();
  });
});
