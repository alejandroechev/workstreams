import { describe, expect, it } from "vitest";

import { groupConfigItems } from "../config-grouping";
import type { CopilotConfigItem } from "../types";

const ORDER = ["skill", "extension", "agent", "mcp_server", "instruction"];

function item(name: string, category: string): CopilotConfigItem {
  return { name, category, source: "user", path: `/c/${name}`, description: null };
}

describe("groupConfigItems", () => {
  it("returns no groups for an empty list", () => {
    expect(groupConfigItems([], ORDER)).toEqual([]);
  });

  it("sorts items case-insensitively inside each group", () => {
    const groups = groupConfigItems(
      [
        item("zeta-skill", "skill"),
        item("Alpha-skill", "skill"),
        item("beta-skill", "skill"),
        item("Gamma-skill", "skill"),
      ],
      ORDER,
    );
    expect(groups[0].items.map((i) => i.name)).toEqual([
      "Alpha-skill",
      "beta-skill",
      "Gamma-skill",
      "zeta-skill",
    ]);
  });

  it("keeps already-sorted input unchanged", () => {
    const groups = groupConfigItems([item("a", "skill"), item("b", "skill")], ORDER);
    expect(groups[0].items.map((i) => i.name)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const items = [item("z", "skill"), item("a", "skill")];
    groupConfigItems(items, ORDER);
    expect(items.map((i) => i.name)).toEqual(["z", "a"]);
  });

  it("preserves category order and drops empty groups", () => {
    const groups = groupConfigItems(
      [item("ext", "extension"), item("skl", "skill"), item("ins", "instruction")],
      ORDER,
    );
    expect(groups.map((g) => g.category)).toEqual(["skill", "extension", "instruction"]);
  });

  it("ignores items in unknown categories", () => {
    const groups = groupConfigItems([item("p", "plugin")], ORDER);
    expect(groups).toEqual([]);
  });
});
