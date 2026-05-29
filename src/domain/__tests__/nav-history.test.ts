import { describe, it, expect } from "vitest";
import {
  createNavigationStack,
  pushPath,
  goBack,
  goForward,
  replacePath,
  currentPath,
  canGoBack,
  canGoForward,
} from "../nav-history";

describe("nav-history", () => {
  it("starts with a single entry, no back/forward available", () => {
    const s = createNavigationStack("a.md");
    expect(currentPath(s)).toBe("a.md");
    expect(canGoBack(s)).toBe(false);
    expect(canGoForward(s)).toBe(false);
  });

  it("pushes a new path and enables back", () => {
    let s = createNavigationStack("a.md");
    s = pushPath(s, "b.md");
    expect(currentPath(s)).toBe("b.md");
    expect(canGoBack(s)).toBe(true);
    expect(canGoForward(s)).toBe(false);
  });

  it("back/forward navigate between entries", () => {
    let s = createNavigationStack("a.md");
    s = pushPath(s, "b.md");
    s = pushPath(s, "c.md");
    s = goBack(s);
    expect(currentPath(s)).toBe("b.md");
    expect(canGoBack(s)).toBe(true);
    expect(canGoForward(s)).toBe(true);
    s = goBack(s);
    expect(currentPath(s)).toBe("a.md");
    expect(canGoBack(s)).toBe(false);
    s = goForward(s);
    expect(currentPath(s)).toBe("b.md");
  });

  it("pushing after going back truncates forward history", () => {
    let s = createNavigationStack("a.md");
    s = pushPath(s, "b.md");
    s = pushPath(s, "c.md");
    s = goBack(s); // b
    s = pushPath(s, "d.md");
    expect(currentPath(s)).toBe("d.md");
    expect(canGoForward(s)).toBe(false);
    expect(s.entries).toEqual(["a.md", "b.md", "d.md"]);
  });

  it("pushing the same path twice is a no-op", () => {
    let s = createNavigationStack("a.md");
    s = pushPath(s, "a.md");
    expect(s.entries.length).toBe(1);
  });

  it("back at start and forward at end are no-ops", () => {
    let s = createNavigationStack("a.md");
    expect(goBack(s)).toBe(s);
    s = pushPath(s, "b.md");
    expect(goForward(s)).toBe(s);
  });

  it("replacePath swaps current without touching history", () => {
    let s = createNavigationStack("a.md");
    s = pushPath(s, "b.md");
    s = replacePath(s, "B.md");
    expect(currentPath(s)).toBe("B.md");
    expect(canGoBack(s)).toBe(true);
    expect(s.entries).toEqual(["a.md", "B.md"]);
  });
});
