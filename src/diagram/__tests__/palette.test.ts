import { describe, expect, it } from "vitest";
import { PALETTE } from "../palette";

describe("software shape palette", () => {
  it("offers the named shapes for each kind in scope", () => {
    const names = PALETTE.map((p) => `${p.kind}: ${p.name}`);
    for (const wanted of [
      "Flow: Component", "Flow: Actor",
      "Sequence: Actor with lifeline", "Sequence: Message", "Sequence: Reply",
      "Class: Class box", "Class: Inheritance",
      "State: State", "State: Initial state", "State: Final state", "State: Transition",
    ]) expect(names).toContain(wanted);
  });

  it("only references ids defined in the same item", () => {
    for (const item of PALETTE) {
      const ids = new Set(item.skeletons.map((s) => s.id).filter(Boolean));
      for (const s of item.skeletons) {
        for (const end of [s.start, s.end]) if (end && "id" in end) expect(ids.has(end.id)).toBe(true);
      }
    }
  });
});
