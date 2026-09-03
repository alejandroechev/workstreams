import { beforeEach, describe, it, expect, vi } from "vitest";

import { getMonacoIfLoaded } from "../../files/loadMonaco";
import {
  shouldSwallowKeyEvent,
  parseKeyAction,
  isPlainEnterCommit,
  APP_KEY_BINDINGS,
} from "../keyboard";

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
    expect(parseKeyAction({ key: "c", ...alt })).toEqual({ type: "addTile", tileType: "copilot_session" });
    expect(parseKeyAction({ key: "r", ...alt })).toEqual({ type: "addTile", tileType: "file_explorer" });
    expect(parseKeyAction({ key: "p", ...alt })).toEqual({ type: "addTile", tileType: "plan" });
    expect(parseKeyAction({ key: "a", ...alt })).toEqual({ type: "addTile", tileType: "code_review" });
    expect(parseKeyAction({ key: "l", ...alt })).toEqual({ type: "addTile", tileType: "loop_control" });
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

    for (const key of ["c", "t", "w", "r", "m", "b", "p", "a", "l"]) {
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

  it("returns toggleSideBySide for Alt+S", () => {
    expect(parseKeyAction({ key: "s", ...alt })).toEqual({ type: "toggleSideBySide" });
  });

  it("returns null for Alt+1-9 (no shortcut for workstream switching)", () => {
    for (let i = 1; i <= 9; i++) {
      expect(parseKeyAction({ key: String(i), ...alt })).toBeNull();
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

  it("returns addTile for Alt+D (walkthrough)", () => {
    expect(parseKeyAction({ key: "d", ...alt })).toEqual({ type: "addTile", tileType: "debug_walkthrough" });
    // And via code, for macOS Option+D which arrives as a special character.
    expect(parseKeyAction({ key: "\u2202", code: "KeyD", ...alt })).toEqual({
      type: "addTile",
      tileType: "debug_walkthrough",
    });
  });

  it("Alt+N (old terminal shortcut) is no longer mapped", () => {
    expect(parseKeyAction({ key: "n", ...alt })).toBeNull();
  });

  it("Alt+E (old explorer shortcut) is no longer mapped", () => {
    expect(parseKeyAction({ key: "e", ...alt })).toBeNull();
  });

  // macOS: Option+<letter> does not produce the plain letter in `event.key`.
  // The OS applies the dead-key/special-character layer first, so Option+T
  // arrives as "†", Option+C as "ç", and so on. Matching on `key` alone means
  // every tile shortcut silently does nothing on a Mac. `event.code` is
  // layout-independent ("KeyT") and is the correct thing to match.
  describe("macOS Option+<letter> (event.key is a special character)", () => {
    it("maps Option+T to a terminal tile via code", () => {
      expect(parseKeyAction({ key: "†", code: "KeyT", ...alt })).toEqual({
        type: "addTile",
        tileType: "terminal",
      });
    });

    it("maps the remaining tile-creation shortcuts via code", () => {
      expect(parseKeyAction({ key: "ç", code: "KeyC", ...alt })).toEqual({
        type: "addTile",
        tileType: "copilot_session",
      });
      expect(parseKeyAction({ key: "®", code: "KeyR", ...alt })).toEqual({
        type: "addTile",
        tileType: "file_explorer",
      });
      expect(parseKeyAction({ key: "µ", code: "KeyM", ...alt })).toEqual({
        type: "addTile",
        tileType: "session_meta",
      });
      expect(parseKeyAction({ key: "∫", code: "KeyB", ...alt })).toEqual({
        type: "addTile",
        tileType: "workbench",
      });
      expect(parseKeyAction({ key: "π", code: "KeyP", ...alt })).toEqual({
        type: "addTile",
        tileType: "plan",
      });
      expect(parseKeyAction({ key: "å", code: "KeyA", ...alt })).toEqual({
        type: "addTile",
        tileType: "code_review",
      });
      expect(parseKeyAction({ key: "¬", code: "KeyL", ...alt })).toEqual({
        type: "addTile",
        tileType: "loop_control",
      });
    });

    it("maps tile-management shortcuts via code", () => {
      expect(parseKeyAction({ key: "œ", code: "KeyQ", ...alt })).toEqual({ type: "closeTile" });
      expect(parseKeyAction({ key: "ƒ", code: "KeyF", ...alt })).toEqual({ type: "toggleFullscreen" });
      expect(parseKeyAction({ key: "ß", code: "KeyS", ...alt })).toEqual({ type: "toggleSideBySide" });
    });

    it("still suppresses tile shortcuts while Monaco has focus", () => {
      // The Monaco guard keys off the same letter set, so it must recognise
      // the code-derived letter too — otherwise Option+T would create a tile
      // while the user is typing in the editor.
      const editor = { hasTextFocus: () => true };
      getMonacoIfLoadedMock.mockReturnValue({
        editor: { getEditors: () => [editor] },
      } as unknown as ReturnType<typeof getMonacoIfLoaded>);
      expect(parseKeyAction({ key: "†", code: "KeyT", ...alt })).toBeNull();
    });

    it("ignores code when Alt is not held", () => {
      expect(parseKeyAction({ key: "†", code: "KeyT", ...noMod })).toBeNull();
    });

    it("keeps working when code is absent (older events / tests)", () => {
      expect(parseKeyAction({ key: "t", ...alt })).toEqual({
        type: "addTile",
        tileType: "terminal",
      });
    });

    it("does not map an unrelated code", () => {
      expect(parseKeyAction({ key: "Ω", code: "KeyZ", ...alt })).toBeNull();
    });
  });
});

describe("APP_KEY_BINDINGS registry", () => {
  const getMonacoIfLoadedMock = vi.mocked(getMonacoIfLoaded);

  beforeEach(() => {
    getMonacoIfLoadedMock.mockReset();
    getMonacoIfLoadedMock.mockReturnValue(null);
  });

  it("covers every combo the app handles, exactly once", () => {
    const combos = APP_KEY_BINDINGS.map((b) => b.combo);
    expect(new Set(combos).size).toBe(combos.length);
    expect(combos.sort()).toEqual(
      [
        "Escape",
        "Alt+ArrowLeft",
        "Alt+ArrowRight",
        "Alt+ArrowUp",
        "Alt+ArrowDown",
        "Alt+T",
        "Alt+W",
        "Alt+C",
        "Alt+R",
        "Alt+M",
        "Alt+B",
        "Alt+P",
        "Alt+A",
        "Alt+D",
        "Alt+L",
        "Alt+Q",
        "Alt+F",
        "Alt+S",
      ].sort(),
    );
  });

  it("gives every entry a human-readable description distinct from the action name", () => {
    for (const binding of APP_KEY_BINDINGS) {
      expect(binding.description.length).toBeGreaterThan(5);
      expect(binding.description).not.toBe(binding.action.type);
      expect(binding.description[0]).toBe(binding.description[0].toUpperCase());
    }
  });

  it("round-trips every entry through parseKeyAction", () => {
    for (const binding of APP_KEY_BINDINGS) {
      expect(
        parseKeyAction({
          key: binding.key,
          altKey: binding.altKey,
          ctrlKey: false,
          activeElement: null,
        }),
      ).toEqual(binding.action);
    }
  });

  it("derives the Monaco guard from the tile-creation entries", () => {
    getMonacoIfLoadedMock.mockReturnValue({
      editor: { getEditors: () => [{ hasTextFocus: () => true }] },
    } as never);

    for (const binding of APP_KEY_BINDINGS) {
      const result = parseKeyAction({
        key: binding.key,
        altKey: binding.altKey,
        ctrlKey: false,
        activeElement: null,
      });
      if (binding.tileCreation) {
        expect(result).toBeNull();
      } else {
        expect(result).toEqual(binding.action);
      }
    }
  });

  it("marks exactly the addTile entries as tile creation", () => {
    for (const binding of APP_KEY_BINDINGS) {
      expect(Boolean(binding.tileCreation)).toBe(binding.action.type === "addTile");
    }
  });

  it("records the feature flags gating the Alt+P and Alt+D menu entries", () => {
    const byCombo = new Map(APP_KEY_BINDINGS.map((b) => [b.combo, b]));
    expect(byCombo.get("Alt+P")?.featureFlag).toBe("plan-tile");
    expect(byCombo.get("Alt+D")?.featureFlag).toBe("debug-walkthrough");
    for (const binding of APP_KEY_BINDINGS) {
      if (binding.combo !== "Alt+P" && binding.combo !== "Alt+D") {
        expect(binding.featureFlag).toBeUndefined();
      }
    }
  });

  it("carries Alt+W's wsl shell config", () => {
    const wsl = APP_KEY_BINDINGS.find((b) => b.combo === "Alt+W");
    expect(wsl?.action).toEqual({
      type: "addTile",
      tileType: "terminal",
      extraConfig: { shell: "wsl" },
    });
  });
});

describe("isPlainEnterCommit", () => {
  it("commits on an unmodified Enter", () => {
    expect(isPlainEnterCommit({ key: "Enter" })).toBe(true);
  });

  it("ignores any other key", () => {
    expect(isPlainEnterCommit({ key: "a" })).toBe(false);
    expect(isPlainEnterCommit({ key: "Escape" })).toBe(false);
  });

  it("ignores Enter with a modifier held", () => {
    expect(isPlainEnterCommit({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isPlainEnterCommit({ key: "Enter", metaKey: true })).toBe(false);
    expect(isPlainEnterCommit({ key: "Enter", ctrlKey: true })).toBe(false);
    expect(isPlainEnterCommit({ key: "Enter", altKey: true })).toBe(false);
  });

  it("ignores Enter that is closing an IME composition", () => {
    expect(isPlainEnterCommit({ key: "Enter", isComposing: true })).toBe(false);
  });
});
