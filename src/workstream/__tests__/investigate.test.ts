import { describe, it, expect, vi } from "vitest";
import { MemoryBackend } from "../../backend/memory-backend";
import { deliverFollowUps, startPendingInvestigations } from "../investigate";

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
  isSpawned: vi.fn(() => false),
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
    expect(JSON.parse(tiles[0].config_json).investigation).toBe(true);
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

  it("starts each session once when two runs overlap on stale snapshots", async () => {
    const { backend, item } = await setup();
    const watch = (await backend.getPrInbox()).pipelines![0];
    backend.finishPipelineRun(watch.id, { id: 11, number: "11", result: "failed", finished_at: "2100-01-03T00:00:00Z" });
    const second = (await backend.getPrInbox()).pipeline_items!.find((i) => i.run_number === "11")!;
    await backend.startPipelineInvestigation(item.id);
    await backend.startPipelineInvestigation(second.id);
    const d = deps(backend);
    await Promise.all([startPendingInvestigations(d), startPendingInvestigations(d)]);
    expect(d.spawn).toHaveBeenCalledTimes(2);
    expect(new Set(d.spawn.mock.calls.map((c) => (c as unknown[])[0])).size).toBe(2);
  });

  it("keeps the mount from starting the tile itself, and never starts a running one twice", async () => {
    const { backend, item } = await setup();
    const started = await backend.startPipelineInvestigation(item.id);
    const tile = await backend.createTile(started.workstream_id, "copilot_session", "Investigation", "{}");
    const d = deps(backend);
    d.mount.mockImplementation(async () => { expect(d.markSpawned).toHaveBeenCalledWith(tile.id); });
    await startPendingInvestigations(d);
    expect(d.spawn).toHaveBeenCalledWith(tile.id, expect.any(String), "copilot", expect.any(String));

    const other = await setup();
    const again = await other.backend.startPipelineInvestigation(other.item.id);
    const running = await other.backend.createTile(again.workstream_id, "copilot_session", "Investigation", "{}");
    const d2 = { ...deps(other.backend), isSpawned: vi.fn((id: string) => id === running.id) };
    await startPendingInvestigations(d2);
    expect(d2.spawn).not.toHaveBeenCalled();
    expect(await other.backend.pendingInvestigationSessions()).toEqual([]);
  });

  it("makes one workstream when a run is investigated twice at once", async () => {
    const { backend, item } = await setup();
    const [a, b] = await Promise.all([backend.startPipelineInvestigation(item.id), backend.startPipelineInvestigation(item.id)]);
    expect(a.workstream_id).toBe(b.workstream_id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });

  it("never reuses a branch, and starts a PR run from the default branch", async () => {
    const backend = new MemoryBackend();
    const project = await backend.createProject("media_components", "/code/mc");
    await backend.setProjectRemote(project.id, "https://dev.azure.com/skype/SCC/_git/media_components");
    backend.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 812, name: "media_components-CI",
      repository: { id: "g", kind: "azure", organization: "skype", project: "SCC", name: "media_components" } });
    const watch = await backend.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=812", "failures");
    // PR runs notify only with all branches watched.
    await backend.setPipelineWatchBranches(watch.id, "all");
    backend.finishPipelineRun(watch.id, { id: 9, number: "9", result: "failed", branch: "refs/pull/1/merge", finished_at: "2100-01-01T00:00:00Z" });
    const item = (await backend.getPrInbox()).pipeline_items![0];
    const first = await backend.startPipelineInvestigation(item.id);
    await backend.deleteWorkstream(first.workstream_id);
    await backend.startPipelineInvestigation(item.id);
    expect(backend.investigationWorktreeRequests()).toEqual([
      { directory: "/code/mc", branch: "investigate/media_components-CI-9", base: "origin/main" },
      { directory: "/code/mc", branch: "investigate/media_components-CI-9-2", base: "origin/main" },
    ]);
  });

  it("doesn't start a session again when only recording that it started failed", async () => {
    const { backend, item } = await setup();
    await backend.startPipelineInvestigation(item.id);
    const spawned = new Set<string>();
    const d = {
      ...deps(backend),
      isSpawned: (id: string) => spawned.has(id),
      markSpawned: vi.fn((id: string) => { spawned.add(id); }),
      unmarkSpawned: vi.fn((id: string) => { spawned.delete(id); }),
    };
    const mark = backend.markInvestigationSessionStarted.bind(backend);
    let fails = 1;
    backend.markInvestigationSessionStarted = async (id) => { if (fails-- > 0) throw new Error("db busy"); return mark(id); };
    await startPendingInvestigations(d);
    await startPendingInvestigations(d);
    expect(d.spawn).toHaveBeenCalledTimes(1);
    expect(d.unmarkSpawned).not.toHaveBeenCalled();
    expect(await backend.pendingInvestigationSessions()).toEqual([]);
  });

  it("after a restart, a tile already linked to a session counts as started and is left to resume", async () => {
    const { backend, item } = await setup();
    const started = await backend.startPipelineInvestigation(item.id);
    const tile = await backend.createTile(started.workstream_id, "copilot_session", "Investigation",
      JSON.stringify({ command_template: "copilot", copilot_session_id: "s-1" }));
    const d = deps(backend);
    await startPendingInvestigations(d);
    expect(d.spawn).not.toHaveBeenCalled();
    expect(d.markSpawned).not.toHaveBeenCalledWith(tile.id);
    expect(await backend.pendingInvestigationSessions()).toEqual([]);
  });
});

describe("auto-started investigation sessions are rechecked at dispatch (f4)", () => {
  it("doesn't spawn one whose start was dropped by a mute while it mounted", async () => {
    const backend = new MemoryBackend();
    let now = new Date(2100, 2, 1, 9, 30);
    backend.setDigestClock(() => now);
    backend.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 1, name: "CI-Main" });
    const watch = await backend.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=1", "daily_failures");
    await backend.setPipelineAutoInvestigate(watch.id, "digest");
    backend.finishPipelineRun(watch.id, { id: 1, number: "1", result: "failed", branch: "main", finished_at: new Date(2100, 2, 1, 12).toISOString() });
    now = new Date(2100, 2, 2, 9, 0);
    backend.runDigestPass();
    expect(await backend.runAutoInvestigations()).toBe(1);
    const d = deps(backend);
    d.mount.mockImplementation(async () => { await backend.setInboxMute(true); });
    await startPendingInvestigations(d);
    expect(d.spawn).not.toHaveBeenCalled();
    await backend.setInboxMute(false);
    await startPendingInvestigations(d);
    expect(d.spawn).not.toHaveBeenCalled();
  });
});

describe("sending a digest's follow-up into an existing investigation (ADR 045)", () => {
  async function withFollowUp(linked: string | null) {
    const backend = new MemoryBackend();
    let now = new Date(2100, 2, 1, 9, 30);
    backend.setDigestClock(() => now);
    backend.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 1, name: "CI-Main" });
    const watch = await backend.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=1", "daily_failures");
    await backend.setPipelineAutoInvestigate(watch.id, "digest");
    backend.finishPipelineRun(watch.id, { id: 1, number: "1", result: "failed", branch: "main", finished_at: new Date(2100, 2, 1, 12).toISOString() });
    now = new Date(2100, 2, 2, 9, 0);
    backend.runDigestPass();
    const started = await backend.runAutoInvestigations();
    expect(started).toBe(1);
    const ws = (await backend.listWorkstreams())[0];
    const tile = await backend.createTile(ws.id, "copilot_session", "Investigate",
      JSON.stringify(linked ? { investigation: true, copilot_session_id: linked } : { investigation: true }));
    await backend.markInvestigationSessionStarted((await backend.pendingInvestigationSessions())[0].event_id);
    backend.finishPipelineRun(watch.id, { id: 2, number: "2", result: "failed", branch: "main", finished_at: new Date(2100, 2, 2, 12).toISOString() });
    now = new Date(2100, 2, 3, 9, 0);
    backend.runDigestPass();
    expect(await backend.pendingInvestigationFollowups()).toHaveLength(1);
    let generation = 0;
    const sent: string[] = [];
    /** Plays the shared resume path: under the tile lock it revalidates, then sends. */
    const hooks = { beforeLock: async () => {} };
    const resume = Object.assign(vi.fn(async (_ws: string, _tile: string, prompt: string, revalidate: (phase: "before-stop" | "before-spawn", sessionId: string) => Promise<void>) => {
      await resume.beforeLock();
      const session = JSON.parse((await backend.listTiles(ws.id)).find((t) => t.id === tile.id)!.config_json).copilot_session_id;
      await revalidate("before-stop", session);
      await revalidate("before-spawn", session);
      sent.push(prompt);
    }), hooks);
    const deps = {
      backend,
      isBusy: vi.fn(() => false),
      turnOpen: vi.fn(async () => false),
      generation: () => generation,
      spawnedRecently: vi.fn(() => false),
      resume,
      inFlight: new Set<string>(),
    };
    return { backend, ws, tile, deps, sent, bump: () => { generation += 1; } };
  }

  it("resumes the investigation's session with the follow-up, once", async () => {
    const { backend, ws, tile, deps, sent } = await withFollowUp("session-1");
    await deliverFollowUps(deps);
    expect(deps.resume).toHaveBeenCalledWith(ws.id, tile.id, expect.stringContaining("buildId=2"), expect.any(Function));
    expect(sent).toHaveLength(1);
    expect(await backend.pendingInvestigationFollowups()).toEqual([]);
    await deliverFollowUps(deps);
    expect(deps.resume).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["mid-turn", { busy: true, open: false, recent: false, linked: "session-1" }],
    ["in an open turn", { busy: false, open: true, recent: false, linked: "session-1" }],
    ["just (re)started", { busy: false, open: false, recent: true, linked: "session-1" }],
    ["not linked to a session", { busy: false, open: false, recent: false, linked: null }],
  ])("skips a session %s", async (_label, opts) => {
    const { backend, deps, sent } = await withFollowUp(opts.linked);
    deps.isBusy.mockReturnValue(opts.busy);
    deps.turnOpen.mockResolvedValue(opts.open);
    deps.spawnedRecently.mockReturnValue(opts.recent);
    await deliverFollowUps(deps);
    expect(sent).toEqual([]);
    expect(await backend.pendingInvestigationFollowups()).toEqual([]);
  });

  it("skips when, waiting for the tile lock, another resume started it, it was relinked, or the Inbox was muted (f4, f5)", async () => {
    for (const meanwhile of ["resumed", "turn", "relinked", "muted"] as const) {
      const { backend, ws, tile, deps, sent, bump } = await withFollowUp("session-1");
      deps.resume.beforeLock = async () => {
        if (meanwhile === "resumed") bump();
        if (meanwhile === "turn") deps.turnOpen.mockResolvedValue(true);
        if (meanwhile === "relinked") await backend.updateTileConfig(tile.id, JSON.stringify({ investigation: true, copilot_session_id: "other" }));
        if (meanwhile === "muted") await backend.setInboxMute(true);
      };
      await deliverFollowUps(deps);
      expect(sent, meanwhile).toEqual([]);
      expect(await backend.pendingInvestigationFollowups(), meanwhile).toEqual([]);
      void ws;
    }
  });
});
