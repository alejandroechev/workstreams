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

describe("TauriBackend sync monitoring", () => {
  beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue(null); });

  it("calls the native sync monitor commands", async () => {
    const b = new TauriBackend();
    const event = { id: "e", kind: "cpu", event: "started" as const, at: 1, message: "m", hint: "h", is_read: false };
    await b.syncMonitorCheck();
    await b.syncMonitorState();
    await b.syncMonitorApply([], [event], [event]);
    await b.syncMonitorSetKey("k");
    await b.syncMonitorSetThresholds({ cpuPercent: 90 });
    await b.syncMonitorMute("cpu", 24);
    await b.syncMonitorSetRead("e", true);
    expect(invoke.mock.calls).toEqual([
      ["sync_monitor_check"],
      ["sync_monitor_state"],
      ["sync_monitor_apply", { problems: [], events: [event], notify: [event] }],
      ["sync_monitor_set_key", { key: "k" }],
      ["sync_monitor_set_thresholds", { thresholds: { cpuPercent: 90 } }],
      ["sync_monitor_mute", { kind: "cpu", hours: 24 }],
      ["sync_monitor_set_read", { id: "e", isRead: true }],
    ]);
  });
});
