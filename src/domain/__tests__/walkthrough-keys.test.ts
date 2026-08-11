import { describe, it, expect } from "vitest";

import { parseWalkthroughKey } from "../walkthrough-keys";

const plain = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe("parseWalkthroughKey", () => {
  it("steps forward on the obvious keys", () => {
    for (const key of ["ArrowDown", "ArrowRight", "j", "n", " "]) {
      expect(parseWalkthroughKey({ key, ...plain })).toBe("next");
    }
  });

  it("steps back on the obvious keys", () => {
    for (const key of ["ArrowUp", "ArrowLeft", "k", "p"]) {
      expect(parseWalkthroughKey({ key, ...plain })).toBe("prev");
    }
  });

  it("jumps to the ends", () => {
    expect(parseWalkthroughKey({ key: "Home", ...plain })).toBe("first");
    expect(parseWalkthroughKey({ key: "End", ...plain })).toBe("last");
  });

  it("resyncs the editor", () => {
    expect(parseWalkthroughKey({ key: "r", ...plain })).toBe("resync");
  });

  it("is case-insensitive for letter keys", () => {
    expect(parseWalkthroughKey({ key: "J", ...plain })).toBe("next");
    expect(parseWalkthroughKey({ key: "R", ...plain })).toBe("resync");
  });

  it("ignores keys held with a modifier", () => {
    // Alt+Arrows move focus between tiles and Cmd+R reloads; stealing those
    // would break navigation the user relies on everywhere else.
    expect(parseWalkthroughKey({ key: "ArrowDown", ...plain, altKey: true })).toBeNull();
    expect(parseWalkthroughKey({ key: "r", ...plain, metaKey: true })).toBeNull();
    expect(parseWalkthroughKey({ key: "j", ...plain, ctrlKey: true })).toBeNull();
  });

  it("ignores unrelated keys", () => {
    expect(parseWalkthroughKey({ key: "x", ...plain })).toBeNull();
    expect(parseWalkthroughKey({ key: "Enter", ...plain })).toBeNull();
  });
});
