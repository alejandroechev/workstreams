import { describe, it, expect } from "vitest";
import {
  normalizeLabelName,
  findLabel,
  resolveLabelNames,
  labelSuggestions,
} from "../task-labels";
import type { Label } from "../tasks";

function label(id: string, name: string): Label {
  return { id, name, color: "#89b4fa" };
}

const EXISTING = [
  label("l1", "AI Crew"),
  label("l2", "OfflineSDK"),
  label("l3", "Bugs/Fixes"),
  label("l4", "FileComments"),
];

describe("normalizeLabelName", () => {
  it("lowercases and trims so casing can never fork a label", () => {
    expect(normalizeLabelName("  AI Crew ")).toBe("ai crew");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizeLabelName("AI   Crew")).toBe("ai crew");
  });

  it("leaves punctuation alone so Bugs/Fixes stays distinct", () => {
    // Stripping punctuation would merge `Bugs/Fixes` with a hypothetical
    // `Bugs Fixes`; the devlog uses the slash meaningfully.
    expect(normalizeLabelName("Bugs/Fixes")).toBe("bugs/fixes");
  });
});

describe("findLabel", () => {
  it("finds an existing label regardless of the casing typed", () => {
    expect(findLabel(EXISTING, "ai crew")?.id).toBe("l1");
    expect(findLabel(EXISTING, "AI CREW")?.id).toBe("l1");
    expect(findLabel(EXISTING, " offlinesdk ")?.id).toBe("l2");
  });

  it("returns null when nothing matches", () => {
    expect(findLabel(EXISTING, "Telemetry")).toBeNull();
  });
});

describe("resolveLabelNames", () => {
  it("reuses an existing label instead of creating a near-duplicate", () => {
    const { labelIds, created } = resolveLabelNames(EXISTING, ["ai crew"]);
    expect(labelIds).toEqual(["l1"]);
    expect(created).toEqual([]);
  });

  it("creates a label when the name is genuinely new, keeping the typed casing", () => {
    const { labelIds, created } = resolveLabelNames(EXISTING, ["Skill Telemetry"]);
    expect(created.map((l) => l.name)).toEqual(["Skill Telemetry"]);
    expect(labelIds).toEqual([created[0].id]);
  });

  it("deduplicates within a single call", () => {
    // Typing the category twice in one paste must not mint two labels.
    const { labelIds, created } = resolveLabelNames(EXISTING, ["Telemetry", "telemetry"]);
    expect(created).toHaveLength(1);
    expect(labelIds).toHaveLength(1);
  });

  it("mints distinct ids for distinct new labels", () => {
    const { created } = resolveLabelNames(EXISTING, ["Alpha", "Beta"]);
    expect(created).toHaveLength(2);
    expect(created[0].id).not.toBe(created[1].id);
  });

  it("ignores blank and whitespace-only names", () => {
    const { labelIds, created } = resolveLabelNames(EXISTING, ["", "   ", "AI Crew"]);
    expect(created).toEqual([]);
    expect(labelIds).toEqual(["l1"]);
  });

  it("preserves the order the names were given", () => {
    const { labelIds } = resolveLabelNames(EXISTING, ["OfflineSDK", "AI Crew"]);
    expect(labelIds).toEqual(["l2", "l1"]);
  });
});

describe("labelSuggestions", () => {
  it("matches on a case-insensitive substring, not just a prefix", () => {
    // Labels now carry section, category and group names, so `Comments` has to
    // find `FileComments` or the dedupe never gets a chance to fire.
    expect(labelSuggestions(EXISTING, "comments").map((l) => l.id)).toEqual(["l4"]);
  });

  it("ranks prefix matches above mid-string matches", () => {
    const labels = [label("a", "SDK Offline"), label("b", "OfflineSDK")];
    expect(labelSuggestions(labels, "offline").map((l) => l.id)).toEqual(["b", "a"]);
  });

  it("returns everything for an empty query", () => {
    expect(labelSuggestions(EXISTING, "  ")).toHaveLength(EXISTING.length);
  });

  it("excludes labels already attached to the task", () => {
    const out = labelSuggestions(EXISTING, "", { exclude: ["l1", "l2"] });
    expect(out.map((l) => l.id)).toEqual(["l3", "l4"]);
  });
});
