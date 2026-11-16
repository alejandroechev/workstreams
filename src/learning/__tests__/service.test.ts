import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemorySettingsStore } from "../../companion/settings";
import { createInMemoryLearningHub } from "../doc";
import { getLearningStatus, learningStatusText, onLearningStatus, startLearningService, type LearningStatus } from "../service";
import { pairLearning, unpairLearning } from "../settings";
import type { LedgerPort } from "../relay";

const ledger: LedgerPort = { enqueue: vi.fn(), get: vi.fn(async () => null) };
const PAIRED = { "learning.doc_url": "automerge:x", "learning.secret": "a".repeat(64), "learning.server_url": "https://s" };

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

function track() {
  const seen: LearningStatus[] = [];
  const off = onLearningStatus((s) => seen.push(s));
  return { seen, off };
}

describe("learning service", () => {
  it("stays off until paired", async () => {
    const connect = vi.fn();
    stop = startLearningService({ store: createMemorySettingsStore(), connect, ledger, devBuild: false });
    await vi.waitFor(() => expect(getLearningStatus()).toEqual({ state: "off" }));
    expect(connect).not.toHaveBeenCalled();
  });

  it("never connects in a development build", async () => {
    const connect = vi.fn();
    stop = startLearningService({ store: createMemorySettingsStore(PAIRED), connect, ledger, devBuild: true });
    await vi.waitFor(() => expect(getLearningStatus()).toEqual({ state: "dev-disabled" }));
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects when paired, and restarts or stops when the pairing changes", async () => {
    const store = createMemorySettingsStore(PAIRED);
    const hub = createInMemoryLearningHub();
    const docs: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const connect = vi.fn(async () => {
      const peer = hub.peer();
      const close = vi.fn(() => peer.close());
      docs.push({ close });
      return { ...peer, close };
    });
    const { seen, off } = track();
    stop = startLearningService({ store, connect, ledger, devBuild: false });
    await vi.waitFor(() => expect(getLearningStatus()).toEqual({ state: "on" }));
    expect(seen[0]).toEqual({ state: "connecting" });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ docUrl: "automerge:x", secret: "a".repeat(64) }));

    await pairLearning(store);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(docs[0].close).toHaveBeenCalled();

    await unpairLearning(store);
    await vi.waitFor(() => expect(getLearningStatus()).toEqual({ state: "off" }));
    expect(docs[1].close).toHaveBeenCalled();
    off();
  });

  it("reports a connection failure", async () => {
    stop = startLearningService({
      store: createMemorySettingsStore(PAIRED),
      connect: async () => { throw new Error("no route"); },
      ledger,
      devBuild: false,
    });
    await vi.waitFor(() => expect(getLearningStatus()).toEqual({ state: "error", error: "no route" }));
  });

  it("describes each state for Settings", () => {
    expect(learningStatusText({ state: "on" })).toMatch(/Connected/);
    expect(learningStatusText({ state: "off" })).toMatch(/Not paired/);
    expect(learningStatusText({ state: "connecting" })).toMatch(/Connecting/);
    expect(learningStatusText({ state: "dev-disabled" })).toMatch(/development/);
    expect(learningStatusText({ state: "update-needed" })).toMatch(/Update Workstreams/);
    expect(learningStatusText({ state: "error", error: "x" })).toBe("Not connected: x");
  });
});
