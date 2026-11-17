import { describe, expect, it } from "vitest";
import {
  activate,
  closeAll,
  closeOthers,
  closeRight,
  closeTab,
  emptyTabs,
  jumpTo,
  keep,
  openTab,
  parseTabs,
  serializeTabs,
  switcherOrder,
  togglePin,
  type OpenTabs,
} from "../open-tabs";

const names = (t: OpenTabs) => t.tabs.map((x) => `${x.path}${x.preview ? "~" : ""}`);
const open = (paths: string[], intent: "preview" | "keep" = "keep") =>
  paths.reduce((t, p) => openTab(t, p, intent), emptyTabs());

describe("open tabs", () => {
  it("casual opens replace one preview tab; keeps stay; reopening selects the tab", () => {
    let t = emptyTabs();
    t = openTab(t, "a", "preview");
    t = openTab(t, "b", "preview");
    expect(names(t)).toEqual(["b~"]);
    t = openTab(t, "d", "keep");
    expect(names(t)).toEqual(["b~", "d"]);
    t = openTab(t, "a", "preview");
    expect(names(t)).toEqual(["a~", "d"]);
    expect(t.active).toBe("a");
    t = openTab(t, "d", "preview");
    expect(names(t)).toEqual(["a~", "d"]);
    expect(t.active).toBe("d");
    // Keeping the preview (edit, double-click) makes it a normal tab.
    t = keep(t, "a");
    expect(names(t)).toEqual(["a", "d"]);
    // A keep-open of the current preview keeps it in place.
    t = openTab(openTab(t, "x", "preview"), "x", "keep");
    expect(names(t)).toEqual(["a", "d", "x"]);
  });

  it("a new preview goes right of the active tab", () => {
    let t = open(["a", "b", "c"]);
    t = activate(t, "a");
    t = openTab(t, "p", "preview");
    expect(names(t)).toEqual(["a", "p~", "b", "c"]);
  });

  it("closing activates the most recently used remaining tab", () => {
    let t = open(["a", "b", "c"]);
    t = activate(activate(t, "a"), "c");
    t = closeTab(t, "c");
    expect(t.active).toBe("a");
    t = closeTab(closeTab(t, "a"), "b");
    expect(t).toEqual(emptyTabs());
  });

  it("switcher is most recent first; jump goes to the Nth tab", () => {
    let t = open(["x", "y", "z"]);
    expect(switcherOrder(t)).toEqual(["z", "y", "x"]);
    t = jumpTo(t, 1);
    expect(t.active).toBe("x");
    expect(switcherOrder(t)).toEqual(["x", "z", "y"]);
    expect(jumpTo(t, 9).active).toBe("z"); // past the end: the last tab
  });

  it("close others / to the right / all; pinned tabs survive bulk closes", () => {
    const t = open(["a", "b", "c", "d"]);
    expect(names(closeRight(t, "b"))).toEqual(["a", "b"]);
    expect(names(closeOthers(t, "b"))).toEqual(["b"]);
    expect(closeOthers(t, "b").active).toBe("b");
    expect(names(closeAll(t))).toEqual([]);
    const pinned = togglePin(t, "d");
    expect(pinned.tabs.find((x) => x.path === "d")!.pinned).toBe(true);
    expect(names(closeOthers(pinned, "a"))).toEqual(["a", "d"]);
    expect(names(closeAll(pinned))).toEqual(["d"]);
    // Pinning a preview keeps it.
    expect(names(togglePin(openTab(t, "p", "preview"), "p"))).toContain("p");
  });

  it("round-trips through view state and ignores garbage", () => {
    let t = open(["a", "b"]);
    t = openTab(t, "c", "preview");
    t = togglePin(t, "a");
    t = { ...t, places: { b: { line: 120, cursorLine: 125, cursorColumn: 3 } } };
    const back = parseTabs(JSON.parse(JSON.stringify(serializeTabs(t))));
    expect(back).toEqual(t);
    expect(parseTabs({ tabs: [{ path: 5 }, { path: "ok" }], active: "nope" })).toEqual({
      tabs: [{ path: "ok", preview: false, pinned: false }], active: "ok", recent: ["ok"], places: {},
    });
    expect(parseTabs(undefined)).toEqual(emptyTabs());
  });
});
