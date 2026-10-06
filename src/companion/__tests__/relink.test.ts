import { describe, it, expect, vi } from "vitest";
import { revokeBeforeRelink } from "../relink";

describe("revoking before a tile is re-linked", () => {
  it("revokes and lets the re-link go ahead", async () => {
    const backend = { companionRevokeSession: vi.fn(async () => {}) };
    const tell = vi.fn();
    expect(await revokeBeforeRelink(backend, "t1", tell)).toBe(true);
    expect(backend.companionRevokeSession).toHaveBeenCalledWith("t1");
    expect(tell).not.toHaveBeenCalled();
  });

  it("stops the re-link and says why when revoking fails", async () => {
    const backend = { companionRevokeSession: vi.fn(async () => { throw new Error("database is locked"); }) };
    const tell = vi.fn();
    expect(await revokeBeforeRelink(backend, "t1", tell)).toBe(false);
    expect(tell).toHaveBeenCalledWith("The session was not linked: database is locked");
  });
});
