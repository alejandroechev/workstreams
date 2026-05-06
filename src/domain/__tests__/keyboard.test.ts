import { describe, it, expect } from "vitest";
import { shouldSwallowKeyEvent, parseKeyAction } from "../keyboard";

// Helper to create a mock element with a given tag and optional class
function mockElement(tag: string, className?: string, parentClass?: string): Element {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (parentClass) {
    const parent = document.createElement("div");
    parent.className = parentClass;
    parent.appendChild(el);
  }
  return el;
}

describe("shouldSwallowKeyEvent", () => {
  it("returns false for null", () => {
    expect(shouldSwallowKeyEvent(null)).toBe(false);
  });

  it("returns true for input element", () => {
    expect(shouldSwallowKeyEvent(mockElement("input"))).toBe(true);
  });

  it("returns true for textarea element", () => {
    expect(shouldSwallowKeyEvent(mockElement("textarea"))).toBe(true);
  });

  it("returns true for select element", () => {
    expect(shouldSwallowKeyEvent(mockElement("select"))).toBe(true);
  });

  it("returns true for element inside .xterm", () => {
    const el = mockElement("div", undefined, "xterm");
    expect(shouldSwallowKeyEvent(el)).toBe(true);
  });

  it("returns false for a plain div", () => {
    expect(shouldSwallowKeyEvent(mockElement("div"))).toBe(false);
  });

  it("returns false for a button", () => {
    expect(shouldSwallowKeyEvent(mockElement("button"))).toBe(false);
  });
});

describe("parseKeyAction", () => {
  const noFocus = { ctrlKey: false, activeElement: null };

  it("returns escape action for Escape key", () => {
    expect(parseKeyAction({ key: "Escape", ...noFocus })).toEqual({
      type: "escape",
    });
  });

  it("returns switchWorkstream for Ctrl+1 through Ctrl+9", () => {
    for (let i = 1; i <= 9; i++) {
      expect(
        parseKeyAction({ key: String(i), ctrlKey: true, activeElement: null })
      ).toEqual({ type: "switchWorkstream", index: i - 1 });
    }
  });

  it("returns navigate for Ctrl+Arrow keys", () => {
    expect(parseKeyAction({ key: "ArrowLeft", ctrlKey: true, activeElement: null })).toEqual({ type: "navigate", direction: "left" });
    expect(parseKeyAction({ key: "ArrowRight", ctrlKey: true, activeElement: null })).toEqual({ type: "navigate", direction: "right" });
    expect(parseKeyAction({ key: "ArrowUp", ctrlKey: true, activeElement: null })).toEqual({ type: "navigate", direction: "up" });
    expect(parseKeyAction({ key: "ArrowDown", ctrlKey: true, activeElement: null })).toEqual({ type: "navigate", direction: "down" });
  });

  it("does not navigate on bare arrow keys or hjkl", () => {
    expect(parseKeyAction({ key: "ArrowLeft", ...noFocus })).toBeNull();
    expect(parseKeyAction({ key: "h", ...noFocus })).toBeNull();
    expect(parseKeyAction({ key: "j", ...noFocus })).toBeNull();
  });

  it("Ctrl+Arrow navigates even when input is focused", () => {
    const input = { tagName: "INPUT" } as Element;
    expect(parseKeyAction({ key: "ArrowLeft", ctrlKey: true, activeElement: input })).toEqual({ type: "navigate", direction: "left" });
  });

  it("returns addTile for n, v, e keys", () => {
    expect(parseKeyAction({ key: "n", ...noFocus })).toEqual({ type: "addTile", tileType: "terminal" });
    expect(parseKeyAction({ key: "v", ...noFocus })).toEqual({ type: "addTile", tileType: "file_viewer" });
    expect(parseKeyAction({ key: "e", ...noFocus })).toEqual({ type: "addTile", tileType: "file_explorer" });
  });

  it("returns closeTile for x key", () => {
    expect(parseKeyAction({ key: "x", ...noFocus })).toEqual({ type: "closeTile" });
  });

  it("returns toggleFullscreen for f key", () => {
    expect(parseKeyAction({ key: "f", ...noFocus })).toEqual({ type: "toggleFullscreen" });
  });

  it("returns focusTile for digit keys 1-9", () => {
    for (let i = 1; i <= 9; i++) {
      expect(
        parseKeyAction({ key: String(i), ctrlKey: false, activeElement: null })
      ).toEqual({ type: "focusTile", index: i - 1 });
    }
  });

  it("returns null for unrecognized key", () => {
    expect(parseKeyAction({ key: "z", ...noFocus })).toBeNull();
    expect(parseKeyAction({ key: "Enter", ...noFocus })).toBeNull();
  });

  it("returns null when input is focused (swallowed)", () => {
    const input = mockElement("input");
    expect(parseKeyAction({ key: "n", ctrlKey: false, activeElement: input })).toBeNull();
    expect(parseKeyAction({ key: "h", ctrlKey: false, activeElement: input })).toBeNull();
  });

  it("still returns Escape when input is focused", () => {
    const input = mockElement("input");
    expect(parseKeyAction({ key: "Escape", ctrlKey: false, activeElement: input })).toEqual({
      type: "escape",
    });
  });

  it("still returns switchWorkstream when input is focused", () => {
    const input = mockElement("input");
    expect(parseKeyAction({ key: "3", ctrlKey: true, activeElement: input })).toEqual({
      type: "switchWorkstream",
      index: 2,
    });
  });

  it("returns null when xterm is focused for normal keys", () => {
    const el = mockElement("div", undefined, "xterm");
    expect(parseKeyAction({ key: "n", ctrlKey: false, activeElement: el })).toBeNull();
  });
});
