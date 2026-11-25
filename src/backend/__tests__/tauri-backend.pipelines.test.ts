import { describe, it, expect, vi, beforeEach } from "vitest";
import { TauriBackend } from "../tauri-backend";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("TauriBackend pipelines", () => {
  let backend: TauriBackend;
  beforeEach(() => { invoke.mockReset(); backend = new TauriBackend(); });

  it("adds, re-modes and removes a watched pipeline through the native commands", async () => {
    invoke.mockResolvedValue({ id: "p1" });
    await backend.addPipelineWatch("https://dev.azure.com/o/P/_build?definitionId=1", "both");
    await backend.addPipelineWatch("https://dev.azure.com/o/P/_build?definitionId=2");
    await backend.setPipelineWatchMode("p1", "off");
    await backend.removePipelineWatch("p1");
    expect(invoke.mock.calls).toEqual([
      ["add_pipeline_watch", { url: "https://dev.azure.com/o/P/_build?definitionId=1", mode: "both" }],
      ["add_pipeline_watch", { url: "https://dev.azure.com/o/P/_build?definitionId=2", mode: null }],
      ["set_pipeline_watch_mode", { id: "p1", mode: "off" }],
      ["remove_pipeline_watch", { id: "p1" }],
    ]);
  });

  it("sets the digest time through the native command", async () => {
    invoke.mockResolvedValue("17:30");
    expect(await backend.setPipelineDigestTime("17:30")).toBe("17:30");
    expect(invoke).toHaveBeenCalledWith("set_pipeline_digest_time", { time: "17:30" });
  });

  it("mutes and unmutes the Inbox through the native command", async () => {
    invoke.mockResolvedValue({ muted: true, until: null });
    await backend.setInboxMute(true, "2026-12-01T08:00:00Z");
    await backend.setInboxMute(false);
    expect(invoke.mock.calls).toEqual([
      ["set_inbox_mute", { muted: true, until: "2026-12-01T08:00:00Z" }],
      ["set_inbox_mute", { muted: false, until: null }],
    ]);
  });

  it("sets auto-investigate, runs the asked-for investigations and reads follow-ups natively", async () => {
    invoke.mockResolvedValue(0);
    await backend.setPipelineAutoInvestigate("p1", "digest");
    await backend.runAutoInvestigations();
    await backend.pendingInvestigationFollowups();
    expect(invoke.mock.calls).toEqual([
      ["set_pipeline_auto_investigate", { id: "p1", value: "digest" }],
      ["run_auto_investigations"],
      ["pipeline_investigation_followups"],
    ]);
  });
});
