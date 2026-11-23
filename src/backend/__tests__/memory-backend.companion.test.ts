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

  it("opens a thread named after a laptop tile on its first message, and keeps the latest 200 (ADR 044)", async () => {
    const backend = new MemoryBackend();
    expect(() => backend.companionSendForTests("nope", "result", "x")).toThrow("No tile nope");
    const ws = await backend.createWorkstream("W", "/w");
    const lap = await backend.createTile(ws.id, "copilot_session", "Summarise videos", "{}");
    backend.companionSendForTests(lap.id, "result", "3 new videos", 5);
    expect(await backend.companionListSessions()).toEqual([expect.objectContaining({
      tileId: lap.id, workstreamId: ws.id, prompt: "Summarise videos", canSend: true,
      messages: [expect.objectContaining({ kind: "result", text: "3 new videos" })],
    })]);
    await backend.companionRecordSession({ tileId: "t", workstreamId: "w", requestId: "r", prompt: "p", createdAt: 0 });
    for (let i = 0; i <= 200; i += 1) backend.companionSendForTests("t", "progress", `m${i}`, i * 3_600_000);
    const session = (await backend.companionListSessions()).find((s) => s.tileId === "t")!;
    expect(session.messages).toHaveLength(200);
    expect(session.messages[0].text).toBe("m1");
  });

  it("refuses a terminal tile, as companion.send does", async () => {
    const backend = new MemoryBackend();
    const ws = await backend.createWorkstream("W", "/w");
    const term = await backend.createTile(ws.id, "terminal", "Shell", "{}");
    expect(() => backend.companionSendForTests(term.id, "result", "x")).toThrow("Only a Copilot session tile");
    expect(await backend.companionListSessions()).toEqual([]);
  });

  it("caps a tile at 20 phone messages an hour, not counting prompts", async () => {
    const backend = new MemoryBackend();
    await backend.companionRecordSession({ tileId: "t", workstreamId: "w", requestId: "r", prompt: "p", createdAt: 0 });
    for (let i = 0; i < 20; i += 1) backend.companionSendForTests("t", "progress", `m${i}`, 1_000 + i);
    expect(() => backend.companionSendForTests("t", "result", "x", 2_000)).toThrow("20 messages to your phone");
    // An hour after the first ones, there is room again.
    backend.companionSendForTests("t", "result", "later", 1_000 + 3_600_000);
    expect((await backend.companionListSessions())[0].messages).toHaveLength(21);
  });

  it("claims a laptop tile, restarts a revoked one fresh, and records prompts", async () => {
    const backend = new MemoryBackend();
    const ws = await backend.createWorkstream("W", "/w");
    const lap = (await backend.createTile(ws.id, "copilot_session", "T", JSON.stringify({ copilot_session_id: "s" }))).id;
    await backend.companionClaimSession({ tileId: lap, workstreamId: "w", requestId: "r1", prompt: "Go", createdAt: 1 }, "s");
    await backend.companionAddPrompt(lap, "r1", "Go", 1);
    expect(await backend.companionListSessions()).toEqual([{ tileId: lap, workstreamId: "w", requestId: "r1", prompt: "Go", createdAt: 1, canSend: true, messages: [{ id: "r1", kind: "prompt", text: "Go", at: 1 }] }]);
    await backend.companionRevokeSession(lap);
    expect((await backend.companionListSessions())[0].canSend).toBe(false);
    await expect(backend.companionAddPrompt(lap, "x", "y", 2)).rejects.toThrow("not started from your phone");
    await backend.companionClaimSession({ tileId: lap, workstreamId: "w", requestId: "r2", prompt: "New", createdAt: 3 }, "s");
    expect(await backend.companionListSessions()).toEqual([{ tileId: lap, workstreamId: "w", requestId: "r2", prompt: "New", createdAt: 3, canSend: true, messages: [] }]);
    await expect(backend.companionAddPrompt(lap, "x", " ", 4)).rejects.toThrow("empty");
    await expect(backend.companionClaimSession({ tileId: lap, workstreamId: "w", requestId: "r3", prompt: "x", createdAt: 5 }, "other")).rejects.toThrow("different Copilot session");
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

describe("MemoryBackend phone session permissions", () => {
  it("a revoked tile keeps its history until its agent sends again, which starts a fresh thread", async () => {
    const backend = new MemoryBackend();
    const ws = await backend.createWorkstream("W", "/w");
    const tile = await backend.createTile(ws.id, "copilot_session", "T", "{}");
    await backend.companionRecordSession({ tileId: tile.id, workstreamId: ws.id, requestId: "r", prompt: "p", createdAt: 0 });
    backend.companionSendForTests(tile.id, "result", "kept", 1);
    await backend.companionRevokeSession(tile.id);
    expect((await backend.companionListSessions())[0]).toMatchObject({ canSend: false, messages: [expect.objectContaining({ text: "kept" })] });
    // The process still running the old session is barred; one spawned since may send.
    expect(() => backend.companionSendForTests(tile.id, "result", "old session", 2)).toThrow("linked to another Copilot session");
    await backend.spawnCopilotSession(tile.id, "/w", "s-new");
    backend.companionSendForTests(tile.id, "result", "new session", 2);
    expect((await backend.companionListSessions())[0]).toMatchObject({ canSend: true, prompt: "T", messages: [expect.objectContaining({ text: "new session" })] });
  });

  it("forgets a session whose launch was refused", async () => {
    const backend = new MemoryBackend();
    await backend.companionRecordSession({ tileId: "t", workstreamId: "w", requestId: "r", prompt: "p", createdAt: 0 });
    await backend.companionDeleteSession("t");
    expect(await backend.companionListSessions()).toEqual([]);
  });

  it("logs terminal writes and closes, and exits a session on its second Ctrl+C unless told it is stuck", async () => {
    const backend = new MemoryBackend();
    const emitted: string[] = [];
    const w = window as unknown as { __WS_INVOKE_LOG__?: unknown[]; __WS_EMIT__?: (e: string) => void; __WS_PTY_IGNORES_CTRL_C__?: string[] };
    w.__WS_INVOKE_LOG__ = [];
    w.__WS_EMIT__ = (e) => emitted.push(e);
    w.__WS_PTY_IGNORES_CTRL_C__ = ["stuck"];
    await backend.spawnCopilotSession("ok", "/", null);
    await backend.spawnCopilotSession("stuck", "/", null);
    for (const id of ["ok", "stuck"]) { await backend.writeToTerminal(id, "\u0003"); await backend.writeToTerminal(id, "\u0003"); }
    expect(emitted).toEqual(["pty-exit-ok"]);
    await expect(backend.writeToTerminal("ok", "x")).rejects.toThrow("No terminal");
    await backend.closeTerminal("stuck");
    expect(w.__WS_INVOKE_LOG__.filter((e) => (e as { cmd: string }).cmd !== "spawn_copilot_session").map((e) => (e as { cmd: string }).cmd))
      .toEqual(["write_to_pty", "write_to_pty", "write_to_pty", "write_to_pty", "close_terminal"]);
    delete w.__WS_EMIT__;
    delete w.__WS_PTY_IGNORES_CTRL_C__;
  });
});
