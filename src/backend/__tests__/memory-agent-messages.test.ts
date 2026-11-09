import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("agent messages in the in-memory backend", () => {
  it("stores, lists newest first, marks read, and keeps a deleted workstream's name", async () => {
    const backend = new MemoryBackend();
    const ws = await backend.createWorkstream("Bench", "/b");
    const tile = await backend.createTile(ws.id, "copilot_session", "S", "{}");
    backend.postAgentMessage(ws.id, tile.id, "done", " First ");
    const second = backend.postAgentMessage(ws.id, tile.id, "error", "Second", "body");
    let messages = (await backend.getPrInbox()).agent_messages!;
    expect(messages.map((m) => [m.title, m.workstream_name, m.available])).toEqual([["Second", "Bench", true], ["First", "Bench", true]]);
    await backend.setPrInboxRead(second.id, true);
    await backend.deleteWorkstream(ws.id);
    messages = (await backend.getPrInbox()).agent_messages!;
    expect(messages[0]).toMatchObject({ is_read: true, workstream_name: "Bench", available: false });
  });

  it("refuses what the native command refuses", () => {
    const backend = new MemoryBackend();
    expect(() => backend.postAgentMessage("w", "t", "urgent", "x")).toThrow("info, done, needs-you, error");
    for (let i = 0; i < 20; i++) backend.postAgentMessage("w", "t", "info", "x");
    expect(() => backend.postAgentMessage("w", "t", "info", "x")).toThrow("20 messages");
  });
});
