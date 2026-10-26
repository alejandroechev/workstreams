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
});
