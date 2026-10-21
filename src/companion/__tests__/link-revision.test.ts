import { describe, it, expect } from "vitest";
import { linkRevision } from "../link-revision";

describe("a tile's link revision", () => {
  it("is stable for the same tile and session, and changes with either", async () => {
    const a = await linkRevision("tile-1", "session-a");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await linkRevision("tile-1", "session-a")).toBe(a);
    expect(await linkRevision("tile-1", "session-b")).not.toBe(a);
    expect(await linkRevision("tile-2", "session-a")).not.toBe(a);
  });

  it("does not contain the session id", async () => {
    expect(await linkRevision("t", "abcdef0123456789")).not.toContain("abcdef0123456789");
  });
});
