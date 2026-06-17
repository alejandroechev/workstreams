import { describe, it, expect } from "vitest";
import { computeSessionNameSync } from "../session-name-sync";

const cfg = (o: Record<string, unknown>) => JSON.stringify(o);

describe("computeSessionNameSync", () => {
  it("returns null when the tile has no linked session", () => {
    expect(computeSessionNameSync(cfg({ session_name: "x" }), "x", "New name")).toBeNull();
  });

  it("returns null when the current summary is blank", () => {
    expect(computeSessionNameSync(cfg({ copilot_session_id: "s1", session_name: "x" }), "x", "")).toBeNull();
    expect(computeSessionNameSync(cfg({ copilot_session_id: "s1", session_name: "x" }), "x", "   ")).toBeNull();
    expect(computeSessionNameSync(cfg({ copilot_session_id: "s1", session_name: "x" }), "x", null)).toBeNull();
  });

  it("returns null when already in sync", () => {
    const c = cfg({ copilot_session_id: "s1", session_name: "Same", session_summary: "Same" });
    expect(computeSessionNameSync(c, "Same", "Same")).toBeNull();
  });

  it("updates name and auto-derived title when the summary changed", () => {
    const c = cfg({ copilot_session_id: "s1", session_name: "Old", session_summary: "Old" });
    const r = computeSessionNameSync(c, "Old", "Renamed");
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.configJson).session_name).toBe("Renamed");
    expect(JSON.parse(r!.configJson).session_summary).toBe("Renamed");
    expect(r!.title).toBe("Renamed");
    expect(r!.label).toBe("Renamed");
  });

  it("preserves a manually-customized title but still updates session_name", () => {
    const c = cfg({ copilot_session_id: "s1", session_name: "Old" });
    const r = computeSessionNameSync(c, "My custom title", "Renamed");
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.configJson).session_name).toBe("Renamed");
    expect(r!.title).toBeUndefined();
    expect(r!.label).toBe("Renamed");
  });

  it("sets the title when there was no prior title", () => {
    const c = cfg({ copilot_session_id: "s1", session_name: "Old" });
    const r = computeSessionNameSync(c, null, "Renamed");
    expect(r!.title).toBe("Renamed");
  });

  it("works with resume_by_id as the link field", () => {
    const c = cfg({ resume_by_id: "s2", session_name: "Old" });
    const r = computeSessionNameSync(c, "Old", "Renamed");
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Renamed");
  });

  it("trims the incoming summary", () => {
    const c = cfg({ copilot_session_id: "s1", session_name: "Old" });
    const r = computeSessionNameSync(c, "Old", "  Trimmed  ");
    expect(JSON.parse(r!.configJson).session_name).toBe("Trimmed");
    expect(r!.label).toBe("Trimmed");
  });

  it("returns null for malformed config json", () => {
    expect(computeSessionNameSync("{ not json", "x", "Renamed")).toBeNull();
  });

  it("preserves unrelated config fields", () => {
    const c = cfg({ copilot_session_id: "s1", session_name: "Old", cwd: "C:/repo", icon: "rocket" });
    const r = computeSessionNameSync(c, "Old", "Renamed");
    const parsed = JSON.parse(r!.configJson);
    expect(parsed.cwd).toBe("C:/repo");
    expect(parsed.icon).toBe("rocket");
  });
});
