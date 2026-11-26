import { describe, expect, it, vi } from "vitest";
import { replyToPeriodicSession } from "../periodic-reply";
import { linkRevision } from "../link-revision";
import { periodicLink } from "../publisher";
import type { PeriodicSchedule } from "../../domain/periodic-schedules";

const schedule = { id: "s", tile_id: "p", workstream_id: "w" } as PeriodicSchedule;

async function setup() {
  const posted: Array<[string, string, string, string]> = [];
  const deps = {
    postApp: vi.fn(async (tile: string, ws: string, kind: "prompt" | "result", text: string) => { posted.push([tile, ws, kind, text]); }),
    reply: vi.fn(async () => {}),
    onRecorded: vi.fn(),
  };
  const target = { workstreamId: "w", tileId: "p", linkRevision: await linkRevision("p", periodicLink("p")), prompt: "Check again" };
  return { deps, posted, target };
}

describe("a phone reply in a periodic tile's thread (ADR 046, US-6)", () => {
  it("records the prompt in the thread, then runs it as the next headless turn", async () => {
    const { deps, posted, target } = await setup();
    await replyToPeriodicSession(deps, schedule, target, () => {}, 7);
    expect(posted).toEqual([["p", "w", "prompt", "Check again"]]);
    expect(deps.onRecorded).toHaveBeenCalled();
    expect(deps.reply).toHaveBeenCalledWith("s", "Check again", "phone");
  });

  it("refuses a stale link revision or a request the guard cancelled, touching nothing", async () => {
    const { deps, posted, target } = await setup();
    await expect(replyToPeriodicSession(deps, schedule, { ...target, linkRevision: "old" }, () => {}, 7)).rejects.toThrow(/no longer/);
    await expect(replyToPeriodicSession(deps, schedule, target, () => { throw new Error("expired"); }, 7)).rejects.toThrow("expired");
    expect(posted).toEqual([]);
    expect(deps.reply).not.toHaveBeenCalled();
  });
});
