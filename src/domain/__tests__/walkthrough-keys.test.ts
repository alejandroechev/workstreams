import { describe, it, expect } from "vitest";

import { parseWalkthroughKey, WALKTHROUGH_KEY_BINDINGS } from "../walkthrough-keys";

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

  it("steps out of the current function", () => {
    // `o` for "out", matching the debugger convention users already know.
    expect(parseWalkthroughKey({ key: "o", ...plain })).toBe("out");
    expect(parseWalkthroughKey({ key: "O", ...plain })).toBe("out");
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

describe("WALKTHROUGH_KEY_BINDINGS", () => {
  it("is a non-empty registry", () => {
    expect(WALKTHROUGH_KEY_BINDINGS.length).toBeGreaterThan(0);
  });

  it("parses every declared key to the entry's action", () => {
    for (const binding of WALKTHROUGH_KEY_BINDINGS) {
      expect(binding.keys.length).toBeGreaterThan(0);
      for (const key of binding.keys) {
        expect(parseWalkthroughKey({ key, ...plain })).toBe(binding.action);
        if (binding.letter) {
          expect(parseWalkthroughKey({ key: key.toUpperCase(), ...plain })).toBe(binding.action);
        }
      }
    }
  });

  it("gives every entry a reader-facing combo label and description", () => {
    for (const binding of WALKTHROUGH_KEY_BINDINGS) {
      expect(binding.combo.trim().length).toBeGreaterThan(0);
      expect(binding.description.trim().length).toBeGreaterThan(0);
      expect(binding.description.trim()).not.toBe(binding.action);
    }
  });

  it("covers every supported action, and lists each key once", () => {
    const actions = WALKTHROUGH_KEY_BINDINGS.map((b) => b.action);
    expect(new Set(actions)).toEqual(new Set(["next", "prev", "out", "first", "last", "resync"]));
    const keys = WALKTHROUGH_KEY_BINDINGS.flatMap((b) => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("still disqualifies every registry key when a modifier is held", () => {
    for (const binding of WALKTHROUGH_KEY_BINDINGS) {
      for (const key of binding.keys) {
        expect(parseWalkthroughKey({ key, ...plain, altKey: true })).toBeNull();
        expect(parseWalkthroughKey({ key, ...plain, ctrlKey: true })).toBeNull();
        expect(parseWalkthroughKey({ key, ...plain, metaKey: true })).toBeNull();
      }
    }
  });

  it("matches literal keys case-sensitively", () => {
    // "home"/"end" are not keys any browser emits; only the letter entries
    // tolerate a different case.
    expect(parseWalkthroughKey({ key: "home", ...plain })).toBeNull();
    expect(parseWalkthroughKey({ key: "arrowdown", ...plain })).toBeNull();
  });
});
