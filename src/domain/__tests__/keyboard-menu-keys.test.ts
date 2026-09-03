import { describe, it, expect } from "vitest";

import { APP_KEY_BINDINGS, STATUS_BAR_MENU_KEYS, shortcutForMenuKey } from "../keyboard";
import { shortcutLabel } from "../platform";

describe("tile-creation menu keys", () => {
  it("gives every tile-creation binding a StatusBar menu key", () => {
    for (const binding of APP_KEY_BINDINGS) {
      if (binding.tileCreation) {
        expect(binding.menuKey, `${binding.combo} needs a menuKey`).toBeTruthy();
      } else {
        expect(binding.menuKey).toBeUndefined();
      }
    }
  });

  it("uses a distinct menu key per tile-creation binding", () => {
    const keys = APP_KEY_BINDINGS.filter((b) => b.tileCreation).map((b) => b.menuKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("resolves every StatusBar menu key to its platform-formatted label", () => {
    for (const menuKey of STATUS_BAR_MENU_KEYS) {
      expect(shortcutForMenuKey(menuKey)).toBeTruthy();
    }
  });

  it("matches the labels the Add tile menu used to hardcode", () => {
    expect(shortcutForMenuKey("session")).toBe(shortcutLabel("C"));
    expect(shortcutForMenuKey("terminal")).toBe(shortcutLabel("T"));
    expect(shortcutForMenuKey("wsl")).toBe(shortcutLabel("W"));
    expect(shortcutForMenuKey("explorer")).toBe(shortcutLabel("R"));
    expect(shortcutForMenuKey("meta")).toBe(shortcutLabel("M"));
    expect(shortcutForMenuKey("workbench")).toBe(shortcutLabel("B"));
    expect(shortcutForMenuKey("plan")).toBe(shortcutLabel("P"));
    expect(shortcutForMenuKey("code-review")).toBe(shortcutLabel("A"));
    expect(shortcutForMenuKey("walkthrough")).toBe(shortcutLabel("D"));
    expect(shortcutForMenuKey("loop")).toBe(shortcutLabel("L"));
  });
});
