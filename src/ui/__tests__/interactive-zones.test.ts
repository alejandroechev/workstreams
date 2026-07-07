import { describe, it, expect } from "vitest";
import { INTERACTIVE_ZONES_CLASS, markInteractiveZoneNode } from "../interactive-zones";

describe("interactive-zones", () => {
  it("exposes the stable class name used by theme.css + editor hosts", () => {
    expect(INTERACTIVE_ZONES_CLASS).toBe("interactive-zones");
  });

  it("markInteractiveZoneNode enables pointer events on the zone node", () => {
    const node = document.createElement("div");
    expect(node.style.pointerEvents).toBe("");
    markInteractiveZoneNode(node);
    expect(node.style.pointerEvents).toBe("auto");
  });
});
