import { describe, it, expect, vi } from "vitest";
import { resumePhoneSession, type ResumeSessionDeps } from "../resume-session";
import { linkRevision } from "../link-revision";
import { MemoryBackend } from "../../backend/memory-backend";

async function setup(opts: { linked?: string | null; running?: boolean; failAt?: "stop" | "spawn" } = {}) {
  const backend = new MemoryBackend();
  const ws = await backend.createWorkstream("Alpha", "/repo/alpha");
  const linked = opts.linked === undefined ? "session-s" : opts.linked;
  const config = linked ? { cwd: "/repo/alpha/sub", copilot_session_id: linked } : { cwd: "/repo/alpha/sub" };
  const tile = await backend.createTile(ws.id, "copilot_session", "Alpha/1", JSON.stringify(config));
  const log: string[] = [];
  const spawned = new Set<string>(opts.running === false ? [] : [tile.id]);
  const deps: ResumeSessionDeps = {
    backend,
    mount: vi.fn(async (id: string) => { log.push(`mount:${id === ws.id ? "ws" : id}:${spawned.has(tile.id) ? "marked" : "unmarked"}`); }),
    workstream: (id) => (id === ws.id ? ws : undefined),
    defaultCwd: () => "/home",
    isSpawned: (id) => spawned.has(id),
    markSpawned: (id) => { spawned.add(id); },
    unmarkSpawned: (id) => { spawned.delete(id); log.push("unmark"); },
    markIntentionalRestart: () => log.push("intentional"),
    notice: (_id, text) => log.push(`notice:${text}`),
    stop: vi.fn(async () => { log.push("stop"); if (opts.failAt === "stop") throw new Error("stuck"); return { forced: false }; }),
    spawn: vi.fn(async (_id: string, cwd: string, command: string, sessionId: string, prompt: string | null) => {
      log.push(`spawn:${cwd}:${command}:${sessionId}:${prompt}`);
      if (opts.failAt === "spawn" && prompt !== null) throw new Error("spawn failed");
    }),
    onRecorded: () => log.push("recorded"),
  };
  const rev = linked ? await linkRevision(tile.id, linked) : "none";
  const request = (over: Record<string, unknown> = {}) => ({
    workstreamId: ws.id, tileId: tile.id, linkRevision: rev, prompt: "Use the palette\\nfor every lane",
    command: "copilot --yolo", guard: () => {}, requestId: "r1", now: 100, ...over,
  });
  return { backend, ws, tile, deps, log, spawned, request };
}

describe("resuming a session with a message from the phone", () => {
  it("records the prompt, says so in the terminal, stops the session and resumes it in the same tile", async () => {
    const { backend, tile, deps, log, request } = await setup();
    await resumePhoneSession(deps, request({ prompt: "Use the palette\nfor every lane" }));
    expect(log).toEqual([
      "mount:ws:marked",
      "recorded",
      "notice:Resumed from phone: Use the palette",
      "intentional",
      "stop",
      "spawn:/repo/alpha/sub:copilot --yolo:session-s:Use the palette\nfor every lane",
    ]);
    const [session] = await backend.companionListSessions();
    expect(session).toMatchObject({ tileId: tile.id, requestId: "r1", canSend: true });
    expect(session.messages).toEqual([{ id: "r1", kind: "prompt", text: "Use the palette\nfor every lane", at: 100 }]);
  });

  it("resumes a tile in an unloaded workstream without stopping anything, and keeps the mount from starting it first", async () => {
    const { deps, log, request, spawned, tile } = await setup({ running: false });
    await resumePhoneSession(deps, request());
    expect(log[0]).toBe("mount:ws:marked");
    expect(log).not.toContain("stop");
    expect(log).not.toContain("intentional");
    expect(log[log.length - 1]).toMatch(/^spawn:.*:session-s:Use the palette/);
    expect(spawned.has(tile.id)).toBe(true);
  });

  it.each([
    ["an unlinked tile", { linked: null }, "can't be resumed yet"],
  ])("refuses %s without touching it", async (_label, opts, error) => {
    const { deps, log, request } = await setup(opts);
    await expect(resumePhoneSession(deps, request())).rejects.toThrow(error);
    expect(log).toEqual([]);
  });

  it("refuses a tile linked to another session since the phone looked, touching nothing", async () => {
    const { backend, deps, log, request } = await setup();
    await expect(resumePhoneSession(deps, request({ linkRevision: "0000000000000000" }))).rejects.toThrow("different Copilot session");
    expect(log).toEqual([]);
    expect(await backend.companionListSessions()).toEqual([]);
  });

  it("refuses a tile that is gone, or isn't a Copilot session", async () => {
    const { deps, request } = await setup();
    await expect(resumePhoneSession(deps, request({ tileId: "nope" }))).rejects.toThrow("no longer on the laptop");
  });

  it("stops before the session is touched when the guard refuses", async () => {
    const { deps, log, request } = await setup();
    await expect(resumePhoneSession(deps, request({ guard: () => { throw new Error("expired"); } }))).rejects.toThrow("expired");
    expect(log).toEqual([]);
  });

  it("falls back to a plain resume when it marked the tile, mounted, then failed", async () => {
    const { deps, log, request, spawned, tile } = await setup({ running: false, failAt: "spawn" });
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("spawn failed");
    expect(log[log.length - 1]).toBe("spawn:/repo/alpha/sub:copilot --yolo:session-s:null");
    expect(spawned.has(tile.id)).toBe(true);
  });

  it("restarts the session plainly when stopping it failed midway", async () => {
    const { deps, log, request } = await setup({ failAt: "stop" });
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("stuck");
    expect(log[log.length - 1]).toBe("spawn:/repo/alpha/sub:copilot --yolo:session-s:null");
  });

  it("leaves a running tile alone when refused before it was touched", async () => {
    const { deps, log, request } = await setup();
    let calls = 0;
    const guard = () => { calls += 1; if (calls === 3) throw new Error("stopped"); };
    await expect(resumePhoneSession(deps, request({ guard }))).rejects.toThrow("stopped");
    expect(log).toEqual(["mount:ws:marked"]);
  });

  it("unmarks the tile when it failed before mounting", async () => {
    const { deps, request, spawned, tile } = await setup({ running: false });
    deps.mount = vi.fn(async () => { throw new Error("mount failed"); });
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("mount failed");
    expect(spawned.has(tile.id)).toBe(false);
  });

  it("uses the workstream folder when the tile has no cwd", async () => {
    const { backend, deps, log, request, tile } = await setup();
    await backend.updateTileConfig(tile.id, JSON.stringify({ copilot_session_id: "session-s" }));
    await resumePhoneSession(deps, request());
    expect(log[log.length - 1]).toMatch(/^spawn:\/repo\/alpha:/);
  });
});
