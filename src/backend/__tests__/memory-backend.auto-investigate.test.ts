import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

const local = (d: number, h: number, m = 0) => new Date(2100, 2, d, h, m);

async function setup(count: number) {
  const b = new MemoryBackend();
  let now = local(1, 9, 30);
  b.setDigestClock(() => now);
  const ids: string[] = [];
  for (let n = 1; n <= count; n++) {
    b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: n, name: `P${n}` });
    ids.push((await b.addPipelineWatch(`https://dev.azure.com/skype/SCC/_build?definitionId=${n}`, "daily_failures")).id);
  }
  const fail = (runId: number, d: number) => ids.forEach((id, i) =>
    b.finishPipelineRun(id, { id: runId + i, number: `${runId + i}`, result: "failed", branch: "main", finished_at: local(d, 12).toISOString() }));
  return { b, ids, fail, setNow: (d: Date) => { now = d; } };
}

describe("MemoryBackend auto-investigate", () => {
  it("is set only in Daily failures and resets when leaving it", async () => {
    const { b, ids } = await setup(1);
    b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 9, name: "B" });
    const other = await b.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=9", "failures");
    await expect(b.setPipelineAutoInvestigate(other.id, "digest")).rejects.toThrow("Daily failures");
    await b.setPipelineAutoInvestigate(ids[0], "digest");
    expect((await b.getPrInbox()).pipelines!.find((p) => p.id === ids[0])!.auto_investigate).toBe("digest");
    await b.setPipelineWatchMode(ids[0], "both");
    expect((await b.getPrInbox()).pipelines!.find((p) => p.id === ids[0])!.auto_investigate).toBe("off");
  });

  it("starts with the digest, follows up an existing one, and caps new ones at 3 a day (AT-7, AT-8)", async () => {
    const { b, ids, fail, setNow } = await setup(5);
    // P1 already has an investigation from an earlier digest.
    await b.setPipelineAutoInvestigate(ids[0], "digest");
    fail(100, 1);
    setNow(local(2, 9, 0));
    b.runDigestPass();
    const p1Digest = (await b.getPrInbox()).pipeline_digests!.find((d) => d.pipeline_id === ids[0])!;
    const first = await b.runAutoInvestigations();
    expect(first).toBe(1);
    expect((await b.getPrInbox()).pipeline_digests!.find((d) => d.id === p1Digest.id)!.investigation).not.toBeNull();
    for (const id of ids.slice(1)) await b.setPipelineAutoInvestigate(id, "digest");
    setNow(local(3, 8, 0));
    // The cap counts P1's start yesterday at 09:00 until today 09:00.
    fail(200, 2);
    setNow(local(3, 9, 0));
    b.runDigestPass();
    const made = await b.runAutoInvestigations();
    const digests = (await b.getPrInbox()).pipeline_digests!.filter((d) => d.created_at === local(3, 9, 0).toISOString());
    expect(digests).toHaveLength(5);
    expect(made).toBe(3);
    const p1 = digests.find((d) => d.pipeline_id === ids[0])!;
    expect(p1.investigation).not.toBeNull();
    const followups = await b.pendingInvestigationFollowups();
    expect(followups.map((f) => f.event_id)).toEqual([p1.id]);
    expect(followups[0].prompt).toContain("buildId=200");
    expect(digests.filter((d) => d.investigation === null)).toHaveLength(1);
    expect((await b.pendingInvestigationSessions()).every((p) => p.event_id !== p1.id)).toBe(true);
    // Manual Investigate isn't capped.
    const left = digests.find((d) => d.investigation === null)!;
    expect((await b.startPipelineInvestigation(left.id)).created).toBe(true);
    await b.markInvestigationSessionStarted(p1.id);
    expect(await b.pendingInvestigationFollowups()).toEqual([]);
  });

  it("starts nothing while muted", async () => {
    const { b, ids, fail, setNow } = await setup(1);
    await b.setPipelineAutoInvestigate(ids[0], "digest");
    fail(1, 1);
    await b.setInboxMute(true);
    setNow(local(2, 9, 0));
    b.runDigestPass();
    expect(await b.runAutoInvestigations()).toBe(0);
    expect(await b.listWorkstreams()).toEqual([]);
  });

  it("claims at launch: the cap ledger outlives removed watches (f7)", async () => {
    const { b, ids, fail, setNow } = await setup(4);
    for (const id of ids.slice(0, 3)) await b.setPipelineAutoInvestigate(id, "digest");
    fail(1, 1);
    setNow(local(2, 9, 0));
    b.runDigestPass();
    expect(await b.runAutoInvestigations()).toBe(3);
    for (const id of ids.slice(0, 3)) await b.removePipelineWatch(id);
    await b.setPipelineAutoInvestigate(ids[3], "digest");
    b.finishPipelineRun(ids[3], { id: 50, number: "50", result: "failed", branch: "main", finished_at: local(2, 12).toISOString() });
    // A digest later the same day (the time changed) still meets the cap.
    await b.setPipelineDigestTime("20:00");
    setNow(local(2, 20, 0));
    b.runDigestPass();
    expect((await b.getPrInbox()).pipeline_digests!.some((d) => d.auto_pending)).toBe(true);
    expect(await b.runAutoInvestigations()).toBe(0);
  });

  it("turns a start into a follow-up when an investigation appeared before launch (f7)", async () => {
    const { b, ids, fail, setNow } = await setup(1);
    fail(1, 1);
    setNow(local(2, 9, 0));
    b.runDigestPass();
    const [earlier] = (await b.getPrInbox()).pipeline_digests!;
    await b.setPipelineAutoInvestigate(ids[0], "digest");
    fail(10, 2);
    setNow(local(3, 9, 0));
    b.runDigestPass();
    const later = (await b.getPrInbox()).pipeline_digests!.find((d) => d.id !== earlier.id)!;
    expect(later.auto_pending).toBe(true);
    // Before the app launches it, the earlier digest is investigated by hand.
    await b.startPipelineInvestigation(earlier.id);
    expect(await b.runAutoInvestigations()).toBe(0);
    expect((await b.listWorkstreams()).filter((w) => w.name.startsWith("Investigate "))).toHaveLength(1);
    expect((await b.pendingInvestigationFollowups()).map((f) => f.event_id)).toEqual([later.id]);
  });

  it("muting drops undelivered auto work for good; manual work stays (f4)", async () => {
    const { b, ids, fail, setNow } = await setup(2);
    for (const id of ids) await b.setPipelineAutoInvestigate(id, "digest");
    fail(1, 1);
    setNow(local(2, 9, 0));
    b.runDigestPass();
    expect(await b.runAutoInvestigations()).toBe(2);
    const ws = (await b.listWorkstreams()).find((w) => w.name.startsWith("Investigate P1"))!;
    await b.createTile(ws.id, "copilot_session", "Investigate", JSON.stringify({ investigation: true, copilot_session_id: "s-1" }));
    fail(10, 2);
    setNow(local(3, 9, 0));
    b.runDigestPass();
    const [followUp] = await b.pendingInvestigationFollowups();
    expect(followUp.expected_session_id).toBe("s-1");
    await b.setInboxMute(true);
    expect(await b.pendingInvestigationSessions()).toEqual([]);
    expect(await b.pendingInvestigationFollowups()).toEqual([]);
    await b.setInboxMute(false);
    expect(await b.pendingInvestigationSessions()).toEqual([]);
    expect(await b.pendingInvestigationFollowups()).toEqual([]);
  });
});
