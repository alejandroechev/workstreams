import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";
import type { PrInboxItem } from "../../domain/pr-inbox";

const comment = (id: string, over: Partial<PrInboxItem> = {}): PrInboxItem => ({
  id, project_id: "", repo_name: "Repo", pr_id: 42, kind: "comment", title: "Fix race", author: "Ana", summary: "Dev commented: looks good",
  url: "https://dev.azure.com/o/p/_git/r/pullrequest/42", is_read: false, discovered_at: "2100-03-01T12:00:00Z", subject: "Dev", outcome: "", ...over,
});

async function setup() {
  const b = new MemoryBackend();
  let now = new Date(2100, 2, 1, 9, 30);
  b.setDigestClock(() => now);
  const repo = await b.createProject("Repo", "/repo");
  const ws = await b.createWorkstream("Bench", "/b");
  const tile = await b.createTile(ws.id, "copilot_session", "S", "{}");
  b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 1, name: "CI" });
  b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 2, name: "Daily" });
  const ci = await b.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=1", "failures");
  const daily = await b.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=2", "daily_failures");
  b.recordPrInboxEvent(comment("before", { project_id: repo.id }));
  return { b, repo, ws, tile, ci, daily, setNow: (d: Date) => { now = d; } };
}

const count = async (b: MemoryBackend) => {
  const s = await b.getPrInbox();
  return s.items.length + s.pipeline_items!.length + s.pipeline_digests!.length + s.agent_messages!.length;
};

describe("MemoryBackend Mute all", () => {
  it("drops every source while muted and replays nothing after (AT-9)", async () => {
    const { b, repo, ws, tile, ci, daily, setNow } = await setup();
    expect(await count(b)).toBe(1);
    expect(await b.setInboxMute(true)).toEqual({ muted: true, until: null });
    b.recordPrInboxEvent(comment("muted-comment", { project_id: repo.id, summary: "Dev commented: muted" }));
    b.finishPipelineRun(ci.id, { id: 1, number: "1", result: "failed", branch: "main", finished_at: new Date(2100, 2, 1, 10).toISOString() });
    b.finishPipelineRun(daily.id, { id: 2, number: "2", result: "failed", branch: "main", finished_at: new Date(2100, 2, 1, 10).toISOString() });
    expect(b.postAgentMessage(ws.id, tile.id, "done", "Finished")).toBeNull();
    await b.postAppInboxMessage(ws.id, tile.id, "error", "Schedule paused", "");
    await b.syncMonitorApply([], [{ id: "cpu-1", kind: "cpu", event: "started", at: 1, message: "m", hint: "h", is_read: false }], []);
    setNow(new Date(2100, 2, 2, 9, 0));
    expect(b.runDigestPass()).toEqual([]);
    expect(await count(b)).toBe(1);
    expect((await b.syncMonitorState()).events).toEqual([]);
    expect((await b.getPrInbox()).mute).toEqual({ muted: true, until: null });

    await b.setInboxMute(false);
    b.recordPrInboxEvent(comment("muted-comment-again", { project_id: repo.id, summary: "Dev commented: muted" }));
    b.finishPipelineRun(ci.id, { id: 1, number: "1", result: "failed", branch: "main", finished_at: new Date(2100, 2, 1, 10).toISOString() });
    setNow(new Date(2100, 2, 3, 9, 0));
    b.runDigestPass();
    expect(await count(b)).toBe(1);
    b.recordPrInboxEvent(comment("new", { project_id: repo.id, summary: "Dev commented: new" }));
    expect(await count(b)).toBe(2);
  });

  it("ends a mute by itself at its time, across a reload (AT-10)", async () => {
    const saved = new Map<string, string>();
    const store = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
    const { b, setNow } = await setup();
    b.useInboxSettingsStore(store);
    const until = new Date(2100, 2, 2, 8, 0).toISOString();
    await expect(b.setInboxMute(true, new Date(2000, 0, 1).toISOString())).rejects.toThrow("future");
    expect(await b.setInboxMute(true, until)).toEqual({ muted: true, until });
    const reloaded = new MemoryBackend();
    let now = new Date(2100, 2, 1, 22, 0);
    reloaded.setDigestClock(() => now);
    reloaded.useInboxSettingsStore(store);
    expect((await reloaded.getPrInbox()).mute).toEqual({ muted: true, until });
    now = new Date(2100, 2, 2, 8, 0);
    expect((await reloaded.getPrInbox()).mute).toEqual({ muted: false, until: null });
    setNow(new Date(2100, 2, 1, 23, 0));
    expect(b.isInboxMuted()).toBe(true);
  });
});
