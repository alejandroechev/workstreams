import { beforeEach, describe, it, expect, vi } from "vitest";

import { getMonacoIfLoaded } from "../../files/loadMonaco";
import { shouldSwallowKeyEvent, parseKeyAction } from "../keyboard";

vi.mock("../../files/loadMonaco", () => ({
  getMonacoIfLoaded: vi.fn(() => null),
}));

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

  it("returns true for input/textarea/select", () => {
    expect(shouldSwallowKeyEvent(mockElement("input"))).toBe(true);
    expect(shouldSwallowKeyEvent(mockElement("textarea"))).toBe(true);
    expect(shouldSwallowKeyEvent(mockElement("select"))).toBe(true);
  });

  it("returns true for xterm child", () => {
    expect(shouldSwallowKeyEvent(mockElement("div", "", "xterm"))).toBe(true);
  });

  it("returns false for plain elements", () => {
    expect(shouldSwallowKeyEvent(mockElement("div"))).toBe(false);
    expect(shouldSwallowKeyEvent(mockElement("button"))).toBe(false);
  });
});

describe("parseKeyAction", () => {
  const getMonacoIfLoadedMock = vi.mocked(getMonacoIfLoaded);
  const noMod = { altKey: false, ctrlKey: false, activeElement: null };
  const alt = { altKey: true, ctrlKey: false, activeElement: null };

  beforeEach(() => {
    getMonacoIfLoadedMock.mockReset();
    getMonacoIfLoadedMock.mockReturnValue(null);
  });

  it("returns escape for Escape key", () => {
    expect(parseKeyAction({ key: "Escape", ...noMod })).toEqual({ type: "escape" });
  });

  it("returns navigate for Alt+Arrow keys", () => {
    expect(parseKeyAction({ key: "ArrowLeft", ...alt })).toEqual({ type: "navigate", direction: "left" });
    expect(parseKeyAction({ key: "ArrowRight", ...alt })).toEqual({ type: "navigate", direction: "right" });
    expect(parseKeyAction({ key: "ArrowUp", ...alt })).toEqual({ type: "navigate", direction: "up" });
    expect(parseKeyAction({ key: "ArrowDown", ...alt })).toEqual({ type: "navigate", direction: "down" });
  });

  it("returns addTile for the new tile-creation shortcuts", () => {
    expect(parseKeyAction({ key: "t", ...alt })).toEqual({ type: "addTile", tileType: "terminal" });
    expect(parseKeyAction({ key: "w", ...alt })).toEqual({
      type: "addTile", tileType: "terminal", extraConfig: { shell: "wsl" },
    });
    expect(parseKeyAction({ key: "s", ...alt })).toEqual({ type: "addTile", tileType: "copilot_session" });
    expect(parseKeyAction({ key: "r", ...alt })).toEqual({ type: "addTile", tileType: "file_explorer" });
    expect(parseKeyAction({ key: "p", ...alt })).toEqual({ type: "addTile", tileType: "plan" });
    expect(parseKeyAction({ key: "g", ...alt })).toEqual({ type: "addTile", tileType: "diff_review" });
  });

  it("returns addTile for Alt+M (session_meta) and Alt+B (workbench)", () => {
    expect(parseKeyAction({ key: "m", ...alt })).toEqual({ type: "addTile", tileType: "session_meta" });
    expect(parseKeyAction({ key: "b", ...alt })).toEqual({ type: "addTile", tileType: "workbench" });
  });

  it("returns null for Alt+P when a Monaco editor has text focus", () => {
    getMonacoIfLoadedMock.mockReturnValue({
      editor: { getEditors: () => [{ hasTextFocus: () => true }] },
    } as never);

    expect(parseKeyAction({ key: "p", ...alt })).toBeNull();
  });

  it("returns null for tile-creation shortcuts when a Monaco editor has text focus", () => {
    getMonacoIfLoadedMock.mockReturnValue({
      editor: { getEditors: () => [{ hasTextFocus: () => true }] },
    } as never);

    for (const key of ["s", "t", "w", "r", "m", "b", "p", "g"]) {
      expect(parseKeyAction({ key, ...alt })).toBeNull();
    }
  });

  it("keeps Alt+Arrow shortcuts available when a Monaco editor has text focus", () => {
    getMonacoIfLoadedMock.mockReturnValue({
      editor: { getEditors: () => [{ hasTextFocus: () => true }] },
    } as never);

    expect(parseKeyAction({ key: "ArrowUp", ...alt })).toEqual({ type: "navigate", direction: "up" });
  });

  it("keeps Ctrl+S unaffected when a Monaco editor has text focus", () => {
    getMonacoIfLoadedMock.mockReturnValue({
      editor: { getEditors: () => [{ hasTextFocus: () => true }] },
    } as never);

    expect(parseKeyAction({ key: "s", altKey: false, ctrlKey: true, activeElement: null })).toBeNull();
  });

  it("returns null for tile-creation shortcuts when focus is inside Monaco DOM", () => {
    const monacoRoot = document.createElement("div");
    monacoRoot.className = "monaco-editor";
    const child = document.createElement("input");
    monacoRoot.appendChild(child);

    expect(parseKeyAction({ key: "p", altKey: true, ctrlKey: false, activeElement: child })).toBeNull();
  });

  it("returns null for tile-creation shortcuts when focus is inside FileEditorView root", () => {
    const editorRoot = document.createElement("div");
    editorRoot.dataset.fileEditorRoot = "true";
    const child = document.createElement("button");
    editorRoot.appendChild(child);

    expect(parseKeyAction({ key: "p", altKey: true, ctrlKey: false, activeElement: child })).toBeNull();
  });

  it("returns closeTile for Alt+Q (was Alt+W)", () => {
    expect(parseKeyAction({ key: "q", ...alt })).toEqual({ type: "closeTile" });
  });

  it("returns toggleFullscreen for Alt+F", () => {
    expect(parseKeyAction({ key: "f", ...alt })).toEqual({ type: "toggleFullscreen" });
  });

  it("returns toggleSideBySide for Alt+C", () => {
    expect(parseKeyAction({ key: "c", ...alt })).toEqual({ type: "toggleSideBySide" });
  });

  it("returns switchWorkstream for Alt+1-9", () => {
    for (let i = 1; i <= 9; i++) {
      expect(parseKeyAction({ key: String(i), ...alt })).toEqual({
        type: "switchWorkstream", index: i - 1,
      });
    }
  });

  it("Alt+ works even when input is focused", () => {
    const input = { tagName: "INPUT" } as Element;
    expect(parseKeyAction({ key: "ArrowLeft", altKey: true, ctrlKey: false, activeElement: input }))
      .toEqual({ type: "navigate", direction: "left" });
    expect(parseKeyAction({ key: "t", altKey: true, ctrlKey: false, activeElement: input }))
      .toEqual({ type: "addTile", tileType: "terminal" });
  });

  it("bare keys return null", () => {
    expect(parseKeyAction({ key: "t", ...noMod })).toBeNull();
    expect(parseKeyAction({ key: "s", ...noMod })).toBeNull();
    expect(parseKeyAction({ key: "ArrowLeft", ...noMod })).toBeNull();
    expect(parseKeyAction({ key: "1", ...noMod })).toBeNull();
  });

  it("Ctrl+ keys return null (not used for app commands)", () => {
    expect(parseKeyAction({ key: "p", altKey: false, ctrlKey: true, activeElement: null })).toBeNull();
    expect(parseKeyAction({ key: "f", altKey: false, ctrlKey: true, activeElement: null })).toBeNull();
  });

  it("returns null for unrecognized keys", () => {
    expect(parseKeyAction({ key: "z", ...alt })).toBeNull();
    expect(parseKeyAction({ key: "Enter", ...noMod })).toBeNull();
  });

  it("Alt+N (old terminal shortcut) is no longer mapped", () => {
    expect(parseKeyAction({ key: "n", ...alt })).toBeNull();
  });

  it("Alt+E (old explorer shortcut) is no longer mapped", () => {
    expect(parseKeyAction({ key: "e", ...alt })).toBeNull();
  });
});
