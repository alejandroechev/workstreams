import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

const local = (d: number, h: number, m = 0) => new Date(2100, 2, d, h, m);

async function setup() {
  const b = new MemoryBackend();
  let now = local(1, 9, 30);
  b.setDigestClock(() => now);
  const ids: Record<string, string> = {};
  for (const [n, name] of [[1, "CI-Main"], [2, "Deploy-PPE"], [3, "Docs"]] as const) {
    b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: n, name });
    ids[name] = (await b.addPipelineWatch(`https://dev.azure.com/skype/SCC/_build?definitionId=${n}`, "daily_failures")).id;
  }
  const at = (minute: number) => new Date(local(1, 10).getTime() + minute * 60_000).toISOString();
  const run = (id: number, result: string) => ({ id, number: `${id}`, result, branch: "main", finished_at: at(id), commit: `sha${id}`, step: `Step ${id}` });
  for (let i = 1; i <= 12; i++) b.finishPipelineRun(ids["CI-Main"], run(i, [3, 5, 8, 10, 12].includes(i) ? "failed" : "succeeded"));
  for (let i = 21; i <= 26; i++) b.finishPipelineRun(ids["Deploy-PPE"], run(i, i === 22 ? "failed" : "succeeded"));
  for (let i = 31; i <= 34; i++) b.finishPipelineRun(ids["Docs"], run(i, "succeeded"));
  return { b, ids, setNow: (d: Date) => { now = d; } };
}

describe("MemoryBackend daily digest", () => {
  it("posts one digest per failing pipeline at the digest time, once (AT-2)", async () => {
    const { b, setNow } = await setup();
    setNow(local(2, 8, 59));
    b.runDigestPass();
    expect((await b.getPrInbox()).pipeline_digests).toEqual([]);
    setNow(local(2, 9, 0));
    b.runDigestPass();
    const digests = (await b.getPrInbox()).pipeline_digests!;
    expect(digests.map((d) => [d.pipeline_name, d.failed, d.total, d.state]).sort()).toEqual([
      ["CI-Main", 5, 12, "still_failing"],
      ["Deploy-PPE", 1, 6, "passed_since"],
    ]);
    const ci = digests.find((d) => d.pipeline_name === "CI-Main")!;
    expect(ci.runs.map((r) => [r.run_id, r.step, r.commit])).toEqual([
      [12, "Step 12", "sha12"], [10, "Step 10", "sha10"], [8, "Step 8", "sha8"], [5, "Step 5", "sha5"], [3, "Step 3", "sha3"],
    ]);
    expect(ci.runs[0].url).toBe("https://dev.azure.com/skype/SCC/_build/results?buildId=12");
    setNow(local(2, 15, 0));
    b.runDigestPass();
    expect((await b.getPrInbox()).pipeline_digests).toHaveLength(2);
    await b.setPrInboxRead(ci.id, true);
    expect((await b.getPrInbox()).pipeline_digests!.find((d) => d.id === ci.id)!.is_read).toBe(true);
  });

  it("follows the digest time and covers a missed day once, at most 7 days back (AT-3, AT-4)", async () => {
    const { b, setNow, ids } = await setup();
    expect(await b.setPipelineDigestTime("17:30")).toBe("17:30");
    await expect(b.setPipelineDigestTime("5pm")).rejects.toThrow("HH:MM");
    setNow(local(1, 17, 29));
    b.runDigestPass();
    expect((await b.getPrInbox()).pipeline_digests).toEqual([]);
    setNow(local(1, 17, 30));
    b.runDigestPass();
    expect((await b.getPrInbox()).pipeline_digests).toHaveLength(2);
    expect((await b.getPrInbox()).digest_time).toBe("17:30");
    // Closed from day 1 18:00 until day 12: one entry, only the last 7 days.
    b.finishPipelineRun(ids["CI-Main"], { id: 98, number: "98", result: "failed", branch: "main", finished_at: local(3, 12).toISOString() });
    b.finishPipelineRun(ids["CI-Main"], { id: 99, number: "99", result: "failed", branch: "main", finished_at: local(10, 12).toISOString() });
    setNow(local(12, 10, 0));
    b.runDigestPass();
    b.runDigestPass();
    const digests = (await b.getPrInbox()).pipeline_digests!;
    expect(digests.map((d) => [d.pipeline_name, d.runs.map((r) => r.run_id)])[0]).toEqual(["CI-Main", [99]]);
    expect(digests).toHaveLength(3);
  });

  it("keeps the digest time across a reload when given a store", async () => {
    const saved = new Map<string, string>();
    const store = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
    const first = new MemoryBackend();
    first.useInboxSettingsStore(store);
    await first.setPipelineDigestTime("17:30");
    const reloaded = new MemoryBackend();
    reloaded.useInboxSettingsStore(store);
    expect((await reloaded.getPrInbox()).digest_time).toBe("17:30");
  });

  it("investigates one run of a digest on its own", async () => {
    const { b, setNow } = await setup();
    setNow(local(2, 9, 0));
    b.runDigestPass();
    const ci = (await b.getPrInbox()).pipeline_digests!.find((d) => d.pipeline_name === "CI-Main")!;
    const started = await b.startPipelineInvestigation(`drun:${ci.id}:12`);
    expect(started.created).toBe(true);
    const again = (await b.getPrInbox()).pipeline_digests!.find((d) => d.id === ci.id)!;
    expect(again.runs[0].investigation).toBe(started.workstream_id);
    expect(again.investigation).toBeNull();
    expect((await b.pendingInvestigationSessions())[0].prompt).toContain("#12 (id 12)");
  });

  it("investigates a whole digest as one batch from the default branch tip (AT-6)", async () => {
    const { b, setNow } = await setup();
    const repo = await b.createProject("media_components", "/code/mc");
    b.setProjectRemote(repo.id, "https://dev.azure.com/skype/SCC/_git/media_components");
    const ci = (await b.getPrInbox()).pipelines!.find((p) => p.name === "CI-Main")!;
    await b.setPipelineWatchRepo(ci.id, repo.id);
    setNow(local(2, 9, 0));
    b.runDigestPass();
    const digest = (await b.getPrInbox()).pipeline_digests!.find((d) => d.pipeline_name === "CI-Main")!;
    const started = await b.startPipelineInvestigation(digest.id);
    expect(started.created).toBe(true);
    expect(b.investigationWorktreeRequests()).toEqual([{ directory: "/code/mc", branch: "investigate/CI-Main-failures-21000302", base: "origin/main" }]);
    expect((await b.startPipelineInvestigation(digest.id)).created).toBe(false);
    const shown = (await b.getPrInbox()).pipeline_digests!.find((d) => d.id === digest.id)!;
    expect([shown.investigation, shown.is_read]).toEqual([started.workstream_id, false]);
    const ws = (await b.listWorkstreams()).find((w) => w.id === started.workstream_id)!;
    expect([ws.name, ws.workstream_type]).toEqual(["Investigate CI-Main failures 2100-03-02", "worktree"]);
    const prompt = (await b.pendingInvestigationSessions())[0].prompt;
    for (const id of [3, 5, 8, 10, 12]) {
      expect(prompt).toContain(`https://dev.azure.com/skype/SCC/_build/results?buildId=${id}`);
      expect(prompt).toContain(`commit sha${id}`);
    }
    for (const text of ["5 of 12 runs failed", "Group the runs by root cause", "flaky", "broken", "Change nothing until I ask", "ws-message skill"]) {
      expect(prompt).toContain(text);
    }
  });

  it("never counts a consumed run again after retention expires its digest (f2)", async () => {
    const { b, ids, setNow } = await setup();
    setNow(local(2, 9, 0));
    b.runDigestPass();
    const ci = (await b.getPrInbox()).pipeline_digests!.find((d) => d.pipeline_name === "CI-Main")!;
    await b.setPrInboxRead(ci.id, true);
    b.expireReadEntries(local(7, 13, 0));
    expect((await b.getPrInbox()).pipeline_digests!.some((d) => d.id === ci.id)).toBe(false);
    // The poller sees the same runs again.
    b.finishPipelineRun(ids["CI-Main"], { id: 3, number: "3", result: "failed", branch: "main", finished_at: new Date(local(1, 10).getTime() + 3 * 60_000).toISOString() });
    setNow(local(8, 9, 0));
    b.runDigestPass();
    expect((await b.getPrInbox()).pipeline_digests!.filter((d) => d.pipeline_name === "CI-Main")).toEqual([]);
  });

  it("launches an investigation tile with the configured command exactly as it is", async () => {
    const { b, setNow } = await setup();
    setNow(local(2, 9, 0));
    b.runDigestPass();
    const ci = (await b.getPrInbox()).pipeline_digests!.find((d) => d.pipeline_name === "CI-Main")!;
    const started = await b.startPipelineInvestigation(ci.id);
    const tile = await b.createTile(started.workstream_id, "copilot_session", "I", JSON.stringify({ investigation: true }));
    const log: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    (window as unknown as { __WS_INVOKE_LOG__: typeof log }).__WS_INVOKE_LOG__ = log;
    await b.spawnCopilotSession(tile.id, "/x", null, 30, 120, "my-agent --yolo --allow-all-tools", "go");
    const spawn = log.find((e) => e.cmd === "spawn_copilot_session")!;
    expect(spawn.args.command).toBe("my-agent --yolo --allow-all-tools");
    expect(Object.keys(spawn.args)).not.toContain("denyTools");
    expect(Object.keys(spawn.args)).not.toContain("allowTools");
  });
});
