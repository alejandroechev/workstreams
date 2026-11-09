import { describe, it, expect } from "vitest";
import { checkAgentMessage, groupAgentMessages, levelLabel, previewLines, type AgentMessage } from "../agent-messages";
import { countUnreadInbox } from "../pipeline-inbox";

const msg = (over: Partial<AgentMessage>): AgentMessage => ({
  id: "m", workstream_id: "w1", workstream_name: "Bench", tile_id: "t1", level: "done", title: "T", body: "",
  is_read: false, created_at: "2026-11-09T10:00:00Z", available: true, ...over,
});

describe("agent messages (mirror of src-tauri/src/inbox_messages.rs)", () => {
  it("checks level, title and body like the native command", () => {
    expect(checkAgentMessage("done", "Benchmarks finished", "")).toBeNull();
    expect(checkAgentMessage("urgent", "t", "")).toContain("info, done, needs-you, error");
    expect(checkAgentMessage("done", "  ", "")).toContain("title is required");
    expect(checkAgentMessage("done", "x".repeat(121), "")).toContain("limit is 120");
    expect(checkAgentMessage("done", "t", "x".repeat(20_001))).toContain("limit is 20000");
  });

  it("groups by workstream, the group with the newest message first", () => {
    const groups = groupAgentMessages([
      msg({ id: "a", workstream_id: "w1", created_at: "2026-11-09T10:00:00Z" }),
      msg({ id: "b", workstream_id: "w2", workstream_name: "Investigate", created_at: "2026-11-09T11:00:00Z" }),
      msg({ id: "c", workstream_id: "w1", created_at: "2026-11-09T12:00:00Z" }),
    ]);
    expect(groups.map((g) => [g.workstream_name, g.messages.map((m) => m.id)])).toEqual([["Bench", ["c", "a"]], ["Investigate", ["b"]]]);
  });

  it("labels levels and previews at most two non-empty lines", () => {
    expect(["info", "done", "needs-you", "error"].map(levelLabel)).toEqual(["Info", "Done", "Needs you", "Error"]);
    expect(previewLines("## Results\n\n- a\n- b\n- c")).toEqual(["Results", "a"]);
    expect(previewLines("")).toEqual([]);
  });

  it("counts unread agent messages in the Inbox badge", () => {
    expect(countUnreadInbox({ items: [], agent_messages: [msg({}), msg({ id: "r", is_read: true })] })).toBe(1);
  });
});
