import { describe, it, expect } from "vitest";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { openAutomergeDoc } from "../automerge-doc";
import { emptyDocument, type CompanionDocument } from "../protocol";

/** Two real Automerge repos joined by an in-process channel. */
function pair() {
  const { port1, port2 } = new MessageChannel();
  return [new MessageChannelNetworkAdapter(port1), new MessageChannelNetworkAdapter(port2)];
}

const until = (check: () => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = () => (check() ? resolve() : Date.now() - started > ms ? reject(new Error("timed out")) : setTimeout(tick, 10));
    tick();
  });

describe("Automerge companion document", () => {
  it("creates a document in the protocol's empty shape", async () => {
    const [a] = pair();
    const { doc, url } = await openAutomergeDoc({ network: [a], docUrl: null, storage: false });
    expect(url).toMatch(/^automerge:/);
    expect(doc.read()).toEqual(emptyDocument());
    doc.close();
  });

  it("syncs changes between two peers and notifies subscribers", async () => {
    const [a, b] = pair();
    const laptop = await openAutomergeDoc({ network: [a], docUrl: null, storage: false });
    const phone = await openAutomergeDoc({ network: [b], docUrl: laptop.url, storage: false });
    const seen: CompanionDocument[] = [];
    phone.doc.subscribe((d) => seen.push(d));
    laptop.doc.change((d) => {
      d.laptop.workstreams = [{ id: "w1", name: "Alpha", laneId: null, loaded: true, sessionCount: 2 }];
    });
    await until(() => phone.doc.read().laptop.workstreams.length === 1);
    expect(phone.doc.read().laptop.workstreams[0]).toEqual({ id: "w1", name: "Alpha", laneId: null, loaded: true, sessionCount: 2 });
    expect(seen[seen.length - 1]?.laptop.workstreams[0].name).toBe("Alpha");
    laptop.doc.close();
    phone.doc.close();
  });

  it("relays ephemeral messages without storing them", async () => {
    const [a, b] = pair();
    const laptop = await openAutomergeDoc({ network: [a], docUrl: null, storage: false });
    const phone = await openAutomergeDoc({ network: [b], docUrl: laptop.url, storage: false });
    const heard: unknown[] = [];
    phone.doc.onEphemeral((m) => heard.push(m));
    await until(() => {
      laptop.doc.broadcast({ kind: "presence", sentAt: 7 });
      return heard.length > 0;
    });
    expect(heard[0]).toEqual({ kind: "presence", sentAt: 7 });
    expect(JSON.stringify(phone.doc.read())).not.toContain("presence");
    laptop.doc.close();
    phone.doc.close();
  });

  it("hands out plain copies, never live Automerge proxies", async () => {
    const [a] = pair();
    const { doc } = await openAutomergeDoc({ network: [a], docUrl: null, storage: false });
    const copy = doc.read();
    copy.laptop.lanes.push({ id: "x", name: "X" });
    expect(doc.read().laptop.lanes).toEqual([]);
    doc.close();
  });
});
