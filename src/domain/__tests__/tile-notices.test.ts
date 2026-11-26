import { describe, it, expect } from "vitest";
import { postTileNotice, subscribeTileNotices, terminalSafe } from "../tile-notices";

describe("tile notices", () => {
  it("delivers to a mounted tile right away", () => {
    const got: string[] = [];
    const off = subscribeTileNotices("a", (t) => got.push(t));
    postTileNotice("a", "hello");
    postTileNotice("b", "elsewhere");
    expect(got).toEqual(["hello"]);
    off();
    postTileNotice("a", "after");
    expect(got).toEqual(["hello"]);
    subscribeTileNotices("a", () => {})();
  });

  it("keeps notices for a tile that is not mounted yet, in order, and delivers them once", () => {
    postTileNotice("c", "one");
    postTileNotice("c", "two");
    const got: string[] = [];
    const off = subscribeTileNotices("c", (t) => got.push(t));
    expect(got).toEqual(["one", "two"]);
    off();
    const again: string[] = [];
    subscribeTileNotices("c", (t) => again.push(t))();
    expect(again).toEqual([]);
  });
});

describe("terminalSafe", () => {
  it("replaces C0, DEL and C1 controls so phone text can never become a terminal escape", () => {
    expect(terminalSafe("a\u001b]52;c;eA==\u0007b")).toBe("a ]52;c;eA== b");
    expect(terminalSafe("x\u009d52;c;eA==\u009cy\u0085z\u007f")).toBe("x 52;c;eA== y z ");
    expect(terminalSafe("Use the Catppuccin palette — ñ ✓")).toBe("Use the Catppuccin palette — ñ ✓");
  });
});

describe("a stored one-time notice (ADR 046: a schedule moved)", () => {
  it("is read from the tile's config and the config comes back without it", async () => {
    const { takePendingNotice } = await import("../tile-notices");
    const taken = takePendingNotice(JSON.stringify({ cwd: "/c", pending_notice: "Moved" }));
    expect(taken).toEqual({ text: "Moved", configJson: JSON.stringify({ cwd: "/c" }) });
    expect(takePendingNotice(JSON.stringify({ cwd: "/c" }))).toBeNull();
    expect(takePendingNotice("not json")).toBeNull();
    expect(takePendingNotice(JSON.stringify({ pending_notice: 3 }))).toBeNull();
  });
});
