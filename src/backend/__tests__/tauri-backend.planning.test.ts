import { describe, it, expect, vi, beforeEach } from "vitest";
import { TauriBackend } from "../tauri-backend";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

describe("TauriBackend planning", () => {
  beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue(null); });

  it("calls the native planning commands", async () => {
    const change = { kind: "remove" as const, id: 1, rev: 2 };
    await new TauriBackend().planningState();
    const b = new TauriBackend();
    await b.planningConnect("https://x");
    await b.planningFetch();
    await b.planningSelectSprint("P\\S23");
    await b.planningAddChange(change);
    await b.planningSetDraft([change], []);
    await b.planningPublish();
    await b.planningOrphans();
    await b.planningSetOrphanDays(90);
    await b.planningHideOrphan("repo", "r1", "SCC/x");
    await b.planningUnhideOrphan("pr", "7");
    expect(invoke.mock.calls).toEqual([
      ["planning_state"],
      ["planning_connect", { url: "https://x" }],
      ["planning_fetch"],
      ["planning_select_sprint", { path: "P\\S23" }],
      ["planning_add_change", { change }],
      ["planning_set_draft", { draft: [change], base: [] }],
      ["planning_publish"],
      ["planning_orphans"],
      ["planning_set_orphan_days", { days: 90 }],
      ["planning_hide_orphan", { kind: "repo", id: "r1", label: "SCC/x" }],
      ["planning_unhide_orphan", { kind: "pr", id: "7" }],
    ]);
  });
});
