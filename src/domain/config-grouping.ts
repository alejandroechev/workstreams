import type { CopilotConfigItem } from "./types";

export interface ConfigGroup {
  category: string;
  items: CopilotConfigItem[];
}

/**
 * Groups config items by category following `categoryOrder`, dropping empty
 * groups and sorting each group's items by display name case-insensitively.
 * The input array is never mutated.
 */
export function groupConfigItems(
  items: CopilotConfigItem[],
  categoryOrder: readonly string[],
): ConfigGroup[] {
  return categoryOrder
    .map((category) => ({
      category,
      items: items
        .filter((i) => i.category === category)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    }))
    .filter((g) => g.items.length > 0);
}
