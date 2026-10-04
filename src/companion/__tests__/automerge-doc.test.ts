import { describe, it, expect, vi } from "vitest";
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

  it("shuts its repo down when the document cannot be opened, so nothing keeps reconnecting", async () => {
    const { port1 } = new MessageChannel();
    const adapter = new MessageChannelNetworkAdapter(port1);
    const disconnect = vi.spyOn(adapter, "disconnect");
    await expect(openAutomergeDoc({ docUrl: "automerge:notavalidurl0OIl", network: [adapter], storage: false })).rejects.toThrow();
    expect(disconnect).toHaveBeenCalled();
    port1.close();
  });

  it("closes without throwing even when an adapter never connected", async () => {
    const { port1 } = new MessageChannel();
    const adapter = new MessageChannelNetworkAdapter(port1);
    // The WebSocket adapter asserts it has a socket in disconnect(); the
    // socket only exists once it has connected.
    vi.spyOn(adapter, "disconnect").mockImplementation(() => { throw new Error("Assertion failed"); });
    const { doc } = await openAutomergeDoc({ docUrl: null, network: [adapter], storage: false });
    expect(() => doc.close()).not.toThrow();
    port1.close();
  });

  it("can wait for the server, and says so when it is unreachable", async () => {
    const { port1 } = new MessageChannel();
    const adapter = new MessageChannelNetworkAdapter(port1);
    await expect(openAutomergeDoc({ docUrl: null, network: [adapter], storage: false, waitForNetworkMs: 50 }))
      .rejects.toThrow("Could not connect to the sync server");
    port1.close();
  });

  it("waiting for the server succeeds once a peer is there", async () => {
    const [a, b] = pair();
    const other = await openAutomergeDoc({ docUrl: null, network: [b], storage: false });
    const { doc } = await openAutomergeDoc({ docUrl: null, network: [a], storage: false, waitForNetworkMs: 2000 });
    expect(doc.read().schemaVersion).toBe(1);
    doc.close();
    other.doc.close();
  });
});

