import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

const DAY = 24 * 60 * 60_000;

describe("MemoryBackend phone sessions", () => {
  it("records a phone session once and lists it with its messages", async () => {
    const backend = new MemoryBackend();
    expect(await backend.companionListSessions()).toEqual([]);
    await backend.companionRecordSession({ tileId: "t1", workstreamId: "w", requestId: "r1", prompt: "Do x", createdAt: 1000 });
    await backend.companionRecordSession({ tileId: "t1", workstreamId: "w", requestId: "r2", prompt: "Other", createdAt: 2000 });
    backend.companionSendForTests("t1", "progress", "working", 1500);
    backend.companionSendForTests("t1", "result", "# Done", 1600);
    const [session] = await backend.companionListSessions();
    expect(session).toMatchObject({ tileId: "t1", workstreamId: "w", requestId: "r1", prompt: "Do x", createdAt: 1000 });
    expect(session.messages.map((m) => [m.kind, m.text, m.at])).toEqual([["progress", "working", 1500], ["result", "# Done", 1600]]);
  });

  it("lists sessions newest first and returns copies", async () => {
    const backend = new MemoryBackend();
    await backend.companionRecordSession({ tileId: "a", workstreamId: "w", requestId: "r1", prompt: "A", createdAt: 1 });
    await backend.companionRecordSession({ tileId: "b", workstreamId: "w", requestId: "r2", prompt: "B", createdAt: 2 });
    const listed = await backend.companionListSessions();
    expect(listed.map((s) => s.tileId)).toEqual(["b", "a"]);
    listed[0].messages.push({ id: "x", kind: "result", text: "x", at: 1 });
    expect((await backend.companionListSessions())[0].messages).toEqual([]);
  });

  it("refuses to send from a tile the phone did not start, and keeps the latest 50", async () => {
    const backend = new MemoryBackend();
    expect(() => backend.companionSendForTests("nope", "result", "x")).toThrow("not started from your phone");
    await backend.companionRecordSession({ tileId: "t", workstreamId: "w", requestId: "r", prompt: "p", createdAt: 0 });
    for (let i = 0; i <= 50; i += 1) backend.companionSendForTests("t", "progress", `m${i}`, i);
    const [session] = await backend.companionListSessions();
    expect(session.messages).toHaveLength(50);
    expect(session.messages[0].text).toBe("m1");
  });

  it("prunes sessions with no activity for the retention period", async () => {
    const backend = new MemoryBackend();
    const now = 10 * DAY;
    await backend.companionRecordSession({ tileId: "quiet", workstreamId: "w", requestId: "r1", prompt: "a", createdAt: now - 3 * DAY - 1 });
    await backend.companionRecordSession({ tileId: "busy", workstreamId: "w", requestId: "r2", prompt: "b", createdAt: now - 5 * DAY });
    backend.companionSendForTests("busy", "result", "x", now - DAY);
    expect(await backend.companionPruneSessions(now, 3 * DAY)).toBe(1);
    expect((await backend.companionListSessions()).map((s) => s.tileId)).toEqual(["busy"]);
  });
});
