import { describe, it, expect, vi } from "vitest";
import { createInMemoryHub } from "../doc";
import { emptyDocument, SCHEMA_VERSION } from "../protocol";

describe("in-memory companion document", () => {
  it("starts from an empty, current-version document", () => {
    const doc = createInMemoryHub().peer();
    expect(doc.read()).toEqual(emptyDocument());
    expect(doc.read().schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("shares changes between peers and notifies subscribers", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const seen = vi.fn();
    phone.subscribe(seen);
    laptop.change((d) => { d.laptop.lastSeenAt = 42; });
    expect(phone.read().laptop.lastSeenAt).toBe(42);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ laptop: expect.objectContaining({ lastSeenAt: 42 }) }));
  });

  it("hands out copies, so nothing changes the document outside change()", () => {
    const doc = createInMemoryHub().peer();
    doc.read().laptop.lanes.push({ id: "x", name: "X" });
    expect(doc.read().laptop.lanes).toEqual([]);
  });

  it("delivers ephemeral messages to other peers only, and never stores them", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const laptopHeard = vi.fn();
    const phoneHeard = vi.fn();
    laptop.onEphemeral(laptopHeard);
    phone.onEphemeral(phoneHeard);
    laptop.broadcast({ kind: "presence", sentAt: 1 });
    expect(phoneHeard).toHaveBeenCalledWith({ kind: "presence", sentAt: 1 });
    expect(laptopHeard).not.toHaveBeenCalled();
    expect(JSON.stringify(phone.read())).not.toContain("presence");
  });

  it("stops delivering after unsubscribe and close", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const seen = vi.fn();
    const stop = phone.subscribe(seen);
    stop();
    laptop.change((d) => { d.laptop.lastSeenAt = 1; });
    expect(seen).not.toHaveBeenCalled();
    const heard = vi.fn();
    phone.onEphemeral(heard);
    phone.close();
    laptop.broadcast({ kind: "presence", sentAt: 2 });
    expect(heard).not.toHaveBeenCalled();
  });

  it("can start from a seeded document", () => {
    const seeded = emptyDocument();
    seeded.laptop.lanes = [{ id: "l", name: "Lane" }];
    expect(createInMemoryHub(seeded).peer().read().laptop.lanes).toEqual([{ id: "l", name: "Lane" }]);
  });
});
