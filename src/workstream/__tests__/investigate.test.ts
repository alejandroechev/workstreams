import { describe, it, expect, vi } from "vitest";
import { MemoryBackend } from "../../backend/memory-backend";
import { startPendingInvestigations } from "../investigate";

async function setup() {
  const backend = new MemoryBackend();
  backend.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 812, name: "media_components-CI" });
  const watch = await backend.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=812", "failures");
  backend.finishPipelineRun(watch.id, { id: 9, number: "9", result: "failed", finished_at: "2100-01-01T00:00:00Z" });
  const item = (await backend.getPrInbox()).pipeline_items![0];
  return { backend, item };
}

const deps = (backend: MemoryBackend) => ({
  backend,
  mount: vi.fn(async () => {}),
  onTileCreated: vi.fn(),
  markSpawned: vi.fn(),
  unmarkSpawned: vi.fn(),
  commandFor: () => "copilot",
  spawn: vi.fn(async () => {}),
  inFlight: new Set<string>(),
});

describe("starting investigation sessions", () => {
  it("starts each pending investigation once, in its workstream's folder with its prompt", async () => {
    const { backend, item } = await setup();
    const started = await backend.startPipelineInvestigation(item.id);
    const d = deps(backend);
    await startPendingInvestigations(d);
    expect(d.mount).toHaveBeenCalledWith(started.workstream_id);
    const tiles = await backend.listTiles(started.workstream_id);
    expect(tiles.map((t) => t.tile_type)).toEqual(["copilot_session"]);
    expect(d.spawn).toHaveBeenCalledWith(tiles[0].id, "/Users/demo", "copilot", expect.stringContaining("Investigate a failed Azure DevOps pipeline run"));
    expect(d.onTileCreated).toHaveBeenCalledWith(tiles[0]);
    expect(await backend.pendingInvestigationSessions()).toEqual([]);
    await startPendingInvestigations(d);
    expect(d.spawn).toHaveBeenCalledTimes(1);
  });

  it("leaves a session that failed to start pending, for a later try", async () => {
    const { backend, item } = await setup();
    await backend.startPipelineInvestigation(item.id);
    const d = { ...deps(backend), spawn: vi.fn(async () => { throw new Error("no pty"); }) };
    await startPendingInvestigations(d);
    expect(d.unmarkSpawned).toHaveBeenCalled();
    expect(await backend.pendingInvestigationSessions()).toHaveLength(1);
  });

  it("refuses runs that aren't failures or don't exist", async () => {
    const { backend } = await setup();
    await expect(backend.startPipelineInvestigation("nope")).rejects.toThrow("No pipeline notification");
    const watch = (await backend.getPrInbox()).pipelines![0];
    await backend.setPipelineWatchMode(watch.id, "both");
    backend.finishPipelineRun(watch.id, { id: 10, number: "10", result: "succeeded", finished_at: "2100-01-02T00:00:00Z" });
    const ok = (await backend.getPrInbox()).pipeline_items!.find((i) => i.result === "succeeded")!;
    await expect(backend.startPipelineInvestigation(ok.id)).rejects.toThrow("Only failed runs");
  });

  it("reuses a run's investigation, and starts afresh once its workstream is gone", async () => {
    const { backend, item } = await setup();
    const first = await backend.startPipelineInvestigation(item.id);
    expect(await backend.startPipelineInvestigation(item.id)).toEqual({ workstream_id: first.workstream_id, created: false });
    await backend.deleteWorkstream(first.workstream_id);
    expect((await backend.getPrInbox()).pipeline_items![0].investigation).toBeNull();
    expect((await backend.startPipelineInvestigation(item.id)).created).toBe(true);
  });

  it("skips an investigation already being started", async () => {
    const { backend, item } = await setup();
    await backend.startPipelineInvestigation(item.id);
    const d = deps(backend);
    d.inFlight.add(item.id);
    await startPendingInvestigations(d);
    expect(d.spawn).not.toHaveBeenCalled();
  });
});
