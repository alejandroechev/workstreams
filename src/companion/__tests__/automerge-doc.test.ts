import { describe, it, expect, vi } from "vitest";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { openAutomergeDoc } from "../automerge-doc";
import { Automerge } from "@automerge/automerge-repo/slim";
import { buildSessions, publishSessions } from "../publisher";
import { emptyDocument, SCHEMA_VERSION, type CompanionDocument } from "../protocol";

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

  it("creates a document with other initial contents when given them", async () => {
    const [a] = pair();
    const { doc } = await openAutomergeDoc({ network: [a], docUrl: null, storage: false, initial: { schemaVersion: 1, requests: {} } });
    expect(doc.read()).toEqual({ schemaVersion: 1, requests: {} });
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
    expect(doc.read().schemaVersion).toBe(SCHEMA_VERSION);
    doc.close();
    other.doc.close();
  });

  describe("immutable strings (schema 2)", () => {
    const SECRET = "dGVzdC1zZWNyZXQtZm9yLWNvbXBhbmlvbi1maXh0dXI";

    function strings(value: unknown, path = "", out: Array<[string, string]> = []): Array<[string, string]> {
      if (Automerge.isImmutableString(value)) out.push([path, "immutable"]);
      else if (typeof value === "string") out.push([path, "text"]);
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, `${path}/${k}`, out);
      return out;
    }

    async function publishFifty(initial: CompanionDocument) {
      const [a] = pair();
      const opened = await openAutomergeDoc({ network: [a], docUrl: null, storage: false, initial, immutableStrings: true });
      const stored = [{
        tileId: "tile-1", workstreamId: "ws-1", requestId: "r-1", prompt: "Do the thing", createdAt: 1, canSend: true,
        messages: Array.from({ length: 50 }, (_, i) => ({ id: `m-${i}`, kind: "progress" as const, text: "x".repeat(1000), at: 10 + i })),
      }];
      publishSessions(opened.doc, await buildSessions(stored, new Map([["ws-1", "Alpha"]]), SECRET));
      opened.doc.change((d) => { d.requests["r-9"] = { id: "r-9", kind: "load", args: { workstreamId: "ws-1" }, createdAt: 5, signature: "ab" }; });
      return opened;
    }

    it("stores every string in a v2 document as one immutable value", async () => {
      const opened = await publishFifty(emptyDocument());
      const loaded = Automerge.load(opened.bytes());
      const found = strings(loaded);
      expect(found.length).toBeGreaterThan(100);
      expect(found.filter(([, kind]) => kind === "text")).toEqual([]);
      const ops = Automerge.getAllChanges(loaded).reduce((n, c) => n + Automerge.decodeChange(c).ops.length, 0);
      expect(ops).toBeLessThan(5_000);
      // Readers still get plain text.
      expect(opened.doc.read().sessions?.["tile-1"].messages[0].text).toBe("x".repeat(1000));
      expect(opened.doc.size()).toBe(opened.bytes().byteLength);
      opened.doc.close();
    });

    it("never writes immutable strings into a v1 document", async () => {
      const opened = await publishFifty({ ...emptyDocument(), schemaVersion: 1 });
      const found = strings(Automerge.load(opened.bytes()));
      expect(found.filter(([, kind]) => kind === "immutable")).toEqual([]);
      opened.doc.close();
    });

    it.each([["v2", 20], ["v1", 1_200]] as const)("publishes only the new message when one is appended (%s)", async (version, budget) => {
      const opened = await publishFifty(version === "v1" ? { ...emptyDocument(), schemaVersion: 1 } : emptyDocument());
      const before = Automerge.getAllChanges(Automerge.load(opened.bytes())).length;
      const stored = [{
        tileId: "tile-1", workstreamId: "ws-1", requestId: "r-1", prompt: "Do the thing", createdAt: 1, canSend: true,
        messages: Array.from({ length: 51 }, (_, i) => ({ id: `m-${i}`, kind: "progress" as const, text: "x".repeat(1000), at: 10 + i })),
      }];
      const ops = (bytes: Uint8Array) => Automerge.getAllChanges(Automerge.load(bytes)).reduce((n, c) => n + Automerge.decodeChange(c).ops.length, 0);
      const opsBefore = ops(opened.bytes());
      publishSessions(opened.doc, await buildSessions(stored, new Map([["ws-1", "Alpha"]]), SECRET));
      expect(Automerge.getAllChanges(Automerge.load(opened.bytes())).length).toBe(before + 1);
      // One ~1 KB message: a handful of ops as immutable strings, about one per
      // character as v1 text. Rewriting the session's 50 messages would be ~55,000.
      expect(ops(opened.bytes()) - opsBefore).toBeLessThan(budget);
      opened.doc.close();
    });
  });
  describe("immutableWriter on real Automerge lists", () => {
    it("keeps chained list writes, removed values and enumeration in the wrapped view", async () => {
      const [a] = pair();
      const opened = await openAutomergeDoc({ network: [a], docUrl: null, storage: false, immutableStrings: true });
      let removed: unknown[] = [];
      let keys: string[] = [];
      let spread: unknown[] = [];
      opened.doc.change((d) => {
        const lanes = d.laptop.lanes as unknown as { insertAt(i: number, ...v: unknown[]): { push(...v: unknown[]): number } };
        lanes.insertAt(0, { id: "a", name: "A" }).push({ id: "b", name: "B" }, { id: "c", name: "C" });
        removed = (d.laptop.lanes as unknown as unknown[]).splice(2, 1);
        keys = Object.keys(d.laptop.lanes);
        spread = [...d.laptop.lanes].map((lane) => ({ ...lane }));
      });
      expect(removed).toEqual([{ id: "c", name: "C" }]);
      expect(keys).toEqual(["0", "1"]);
      expect(spread).toEqual([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
      const loaded = Automerge.load(opened.bytes()) as unknown as { laptop: { lanes: Array<Record<string, unknown>> } };
      for (const lane of loaded.laptop.lanes) {
        expect(Automerge.isImmutableString(lane.id)).toBe(true);
        expect(Automerge.isImmutableString(lane.name)).toBe(true);
      }
      opened.doc.close();
    });
  });
});
