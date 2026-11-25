import { describe, it, expect, vi } from "vitest";
import { resumeFollowUpSession, resumePhoneSession, resumeScheduledSession, type ResumeSessionDeps } from "../resume-session";
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
  backend.clearStaleSessionLocks = vi.fn(async (id: string) => { log.push(`clear:${id}`); return 1; });
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
      "clear:session-s",
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

  it("doesn't deliver a request cancelled while the session was stopping, and resumes it plainly instead", async () => {
    const { deps, log, request } = await setup();
    let refuse = false;
    deps.stop = vi.fn(async () => { log.push("stop"); refuse = true; return { forced: false }; });
    const guard = () => { if (refuse) throw new Error("Request expired"); };
    await expect(resumePhoneSession(deps, request({ guard }))).rejects.toThrow("Request expired");
    expect(log.filter((l) => l.startsWith("spawn"))).toEqual(["spawn:/repo/alpha/sub:copilot --yolo:session-s:null"]);
  });

  it("refuses when the tile is re-linked on the laptop while the workstream mounts, without claiming or stopping it", async () => {
    const { backend, deps, log, request, tile } = await setup();
    deps.mount = vi.fn(async () => {
      log.push("mount");
      await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-t" }));
    });
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("different Copilot session");
    expect(log).toEqual(["mount"]);
    expect(await backend.companionListSessions()).toEqual([]);
  });

  it("never claims a tile whose link changed after the last check: the claim itself verifies the linked session", async () => {
    const { backend, tile } = await setup();
    await backend.updateTileConfig(tile.id, JSON.stringify({ copilot_session_id: "session-t" }));
    await expect(backend.companionClaimSession({ tileId: tile.id, workstreamId: "w", requestId: "r", prompt: "p", createdAt: 1 }, "session-s"))
      .rejects.toThrow("different Copilot session");
    expect(await backend.companionListSessions()).toEqual([]);
  });

  it("when re-linked while stopping, resumes the newly linked session without the message, and revokes the claim again", async () => {
    const { backend, deps, log, request, tile } = await setup();
    deps.stop = vi.fn(async () => {
      log.push("stop");
      await backend.companionRevokeSession(tile.id);
      await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-t" }));
      return { forced: false };
    });
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("different Copilot session");
    expect(log.filter((l) => l.startsWith("spawn"))).toEqual(["spawn:/repo/alpha/sub:copilot --yolo:session-t:null"]);
    const [session] = await backend.companionListSessions();
    expect(session.canSend).toBe(false);
  });

  it("checks the link right before launching an unspawned tile too, so a re-link while recording isn't resumed with the message", async () => {
    const { backend, deps, log, request, tile } = await setup({ running: false });
    const addPrompt = backend.companionAddPrompt.bind(backend);
    backend.companionAddPrompt = async (...args) => {
      await addPrompt(...args);
      await backend.companionRevokeSession(tile.id);
      await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-t" }));
    };
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("different Copilot session");
    expect(log.filter((l) => l.startsWith("spawn"))).toEqual(["spawn:/repo/alpha/sub:copilot --yolo:session-t:null"]);
  });

  it("checks the guard after the last link check, right before launching", async () => {
    const { backend, deps, log, request } = await setup();
    const listTiles = backend.listTiles.bind(backend);
    let stopped = false;
    let refuse = false;
    deps.stop = vi.fn(async () => { log.push("stop"); stopped = true; return { forced: false }; });
    // The request expires during the link check that follows the stop.
    backend.listTiles = async (id) => { if (stopped) refuse = true; return listTiles(id); };
    const guard = () => { if (refuse) throw new Error("Request expired"); };
    await expect(resumePhoneSession(deps, request({ guard }))).rejects.toThrow("Request expired");
    expect(log.filter((l) => l.startsWith("spawn"))).toEqual(["spawn:/repo/alpha/sub:copilot --yolo:session-s:null"]);
  });

  it("doesn't stop a tile re-linked while the prompt was being recorded", async () => {
    const { backend, deps, log, request, tile } = await setup();
    const addPrompt = backend.companionAddPrompt.bind(backend);
    backend.companionAddPrompt = async (...args) => {
      await addPrompt(...args);
      await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-t" }));
    };
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("different Copilot session");
    expect(log).not.toContain("stop");
    expect(log.filter((l) => l.startsWith("spawn") || l.startsWith("notice"))).toEqual([]);
    const [session] = await backend.companionListSessions();
    expect(session.canSend).toBe(false);
  });

  it("recovery resumes the session the tile is linked to after revoking, not one read before", async () => {
    const { backend, deps, log, request, tile } = await setup();
    deps.stop = vi.fn(async () => {
      log.push("stop");
      await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-t" }));
      return { forced: false };
    });
    const revoke = backend.companionRevokeSession.bind(backend);
    backend.companionRevokeSession = async (id) => {
      await revoke(id);
      await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-u" }));
    };
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("different Copilot session");
    expect(log.filter((l) => l.startsWith("spawn"))).toEqual(["spawn:/repo/alpha/sub:copilot --yolo:session-u:null"]);
  });

  it("clears the stopped session's stale CLI locks before resuming, so the CLI doesn't ask whether to take it over", async () => {
    const { deps, log, request } = await setup({ running: false });
    await resumePhoneSession(deps, request());
    expect(log.slice(-2)).toEqual(["clear:session-s", "spawn:/repo/alpha/sub:copilot --yolo:session-s:Use the palette\\nfor every lane"]);
  });

  it("still resumes when clearing the locks fails", async () => {
    const { backend, deps, log, request } = await setup();
    backend.clearStaleSessionLocks = vi.fn(async () => { throw new Error("no access"); });
    await resumePhoneSession(deps, request());
    expect(log[log.length - 1]).toMatch(/^spawn:.*:session-s:Use the palette/);
  });

  it("clears the locks before a recovery resume too", async () => {
    const { deps, log, request } = await setup({ failAt: "spawn" });
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("spawn failed");
    expect(log.slice(-2)).toEqual(["clear:session-s", "spawn:/repo/alpha/sub:copilot --yolo:session-s:null"]);
  });
});

describe("resuming a session for a scheduled run (ADR 044)", () => {
  const scheduled = (over: Record<string, unknown> = {}) => ({ prompt: "Check videos\nthen summarise", command: "copilot", scheduleId: "sch", now: 500, ...over });

  it("resumes the tile's session with the prompt, unchanged command, and says so, without touching the phone while it is off", async () => {
    const { backend, ws, tile, deps, log } = await setup();
    await resumeScheduledSession({ ...deps, companionOn: async () => false }, { workstreamId: ws.id, tileId: tile.id, ...scheduled() });
    expect(log).toEqual([
      "mount:ws:marked",
      "notice:Scheduled run: Check videos",
      "intentional",
      "stop",
      "clear:session-s",
      "spawn:/repo/alpha/sub:copilot:session-s:Check videos\nthen summarise",
    ]);
    expect(await backend.companionListSessions()).toEqual([]);
  });

  it("with the companion on, records the prompt in a phone thread named after the tile", async () => {
    const { backend, ws, tile, deps, log } = await setup({ running: false });
    await resumeScheduledSession({ ...deps, companionOn: async () => true }, { workstreamId: ws.id, tileId: tile.id, ...scheduled() });
    expect(log).toContain("recorded");
    const [session] = await backend.companionListSessions();
    expect(session).toMatchObject({ tileId: tile.id, prompt: "Alpha/1", canSend: true });
    expect(session.messages.map((m) => [m.kind, m.text])).toEqual([["prompt", "Check videos\nthen summarise"]]);
    await resumeScheduledSession({ ...deps, companionOn: async () => true }, { workstreamId: ws.id, tileId: tile.id, ...scheduled({ now: 900 }) });
    expect((await backend.companionListSessions())[0].messages).toHaveLength(2);
  });

  it("still runs when recording the prompt fails", async () => {
    const { backend, ws, tile, deps, log } = await setup();
    backend.companionAddPrompt = vi.fn(async () => { throw new Error("db"); });
    await resumeScheduledSession({ ...deps, companionOn: async () => true }, { workstreamId: ws.id, tileId: tile.id, ...scheduled() });
    expect(log[log.length - 1]).toMatch(/^spawn:.*:session-s:Check videos/);
  });

  it("resumes the session the tile is linked to at run time, so a re-linked tile runs its new session", async () => {
    const { backend, ws, tile, deps, log } = await setup();
    await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-new" }));
    await resumeScheduledSession({ ...deps, companionOn: async () => false }, { workstreamId: ws.id, tileId: tile.id, ...scheduled() });
    expect(log[log.length - 1]).toBe("spawn:/repo/alpha/sub:copilot:session-new:Check videos\nthen summarise");
  });

  it("cannot start a tile that is gone or not linked to a session", async () => {
    const { ws, deps, log } = await setup({ linked: null });
    const unlinked = (await deps.backend.listTiles(ws.id))[0];
    await expect(resumeScheduledSession({ ...deps, companionOn: async () => false }, { workstreamId: ws.id, tileId: unlinked.id, ...scheduled() }))
      .rejects.toThrow("isn't linked");
    await expect(resumeScheduledSession({ ...deps, companionOn: async () => false }, { workstreamId: ws.id, tileId: "gone", ...scheduled() }))
      .rejects.toThrow("no longer");
    expect(log).toEqual([]);
  });
});

describe("one resume per tile at a time (review finding 3)", () => {
  it("queues a scheduled run behind a phone message for the same tile, and the queued one revalidates", async () => {
    const { ws, tile, deps, log, request, backend } = await setup();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let stops = 0;
    deps.stop = vi.fn(async () => { stops += 1; log.push(`stop${stops}`); if (stops === 1) await held; return { forced: false }; });
    const phone = resumePhoneSession(deps, request({ prompt: "From phone" }));
    await vi.waitFor(() => expect(log).toContain("stop1"));
    // Re-linked while the phone's resume holds the tile.
    const scheduled = resumeScheduledSession({ ...deps, companionOn: async () => false }, {
      workstreamId: ws.id, tileId: tile.id, prompt: "Scheduled", command: "copilot", scheduleId: "s", now: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(log.filter((l) => l.startsWith("spawn") || l.startsWith("stop"))).toEqual(["stop1"]);
    release();
    await phone;
    await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-z" }));
    await scheduled;
    expect(log.filter((l) => l.startsWith("spawn") || l.startsWith("stop"))).toEqual([
      "stop1", "spawn:/repo/alpha/sub:copilot --yolo:session-s:From phone",
      "stop2", "spawn:/repo/alpha/sub:copilot:session-z:Scheduled",
    ]);
  });

  it("releases the tile after a failure", async () => {
    const { ws, tile, deps, log } = await setup({ failAt: "stop" });
    const scheduled = { workstreamId: ws.id, tileId: tile.id, prompt: "P", command: "c", scheduleId: "s", now: 1 };
    await expect(resumeScheduledSession({ ...deps, companionOn: async () => false }, scheduled)).rejects.toThrow("stuck");
    deps.stop = vi.fn(async () => ({ forced: false }));
    await resumeScheduledSession({ ...deps, companionOn: async () => false }, scheduled);
    expect(log[log.length - 1]).toBe("spawn:/repo/alpha/sub:c:session-s:P");
  });
});

describe("a rollback revokes only what it claimed (review finding 2)", () => {
  it("leaves a newer claim made after a re-link alone", async () => {
    const { backend, deps, request, tile } = await setup();
    deps.stop = vi.fn(async () => {
      // Re-linked meanwhile, and the phone then messaged the new session.
      await backend.companionRevokeSession(tile.id);
      await backend.updateTileConfig(tile.id, JSON.stringify({ cwd: "/repo/alpha/sub", copilot_session_id: "session-t" }));
      await backend.companionClaimSession({ tileId: tile.id, workstreamId: "w", requestId: "newer", prompt: "p", createdAt: 2 }, "session-t");
      return { forced: false };
    });
    await expect(resumePhoneSession(deps, request())).rejects.toThrow("different Copilot session");
    const [session] = await backend.companionListSessions();
    expect(session).toMatchObject({ requestId: "newer", canSend: true });
  });
});

describe("a scheduled resume revalidates before stopping and before spawning (review finding 4)", () => {
  it("stops nothing when the schedule changed before the stop", async () => {
    const { ws, tile, deps, log } = await setup();
    const revalidate = vi.fn(async () => { throw new Error("The schedule was paused."); });
    await expect(resumeScheduledSession({ ...deps, companionOn: async () => false }, {
      workstreamId: ws.id, tileId: tile.id, prompt: "P", command: "c", scheduleId: "s", now: 1, revalidate,
    })).rejects.toThrow("paused");
    expect(log.filter((l) => l === "stop" || l.startsWith("spawn"))).toEqual([]);
  });

  it("restarts the session plainly when the schedule changed while it was stopping", async () => {
    const { ws, tile, deps, log } = await setup();
    let calls = 0;
    const revalidate = vi.fn(async () => { calls += 1; if (calls === 2) throw new Error("The schedule was deleted."); });
    await expect(resumeScheduledSession({ ...deps, companionOn: async () => false }, {
      workstreamId: ws.id, tileId: tile.id, prompt: "P", command: "c", scheduleId: "s", now: 1, revalidate,
    })).rejects.toThrow("deleted");
    expect(log.filter((l) => l === "stop" || l.startsWith("spawn"))).toEqual(["stop", "spawn:/repo/alpha/sub:c:session-s:null"]);
  });
});

describe("recovery never relaunches an archived workstream's tile (round 2, finding 4)", () => {
  it("leaves the tile stopped when the workstream was archived while it stopped", async () => {
    const { ws, tile, deps, log, spawned } = await setup();
    deps.stop = vi.fn(async () => { log.push("stop"); (ws as { status: string }).status = "archiving"; return { forced: false }; });
    const revalidate = vi.fn(async (phase: "before-stop" | "before-spawn") => { if (phase === "before-spawn") throw new Error("The workstream was archived."); });
    await expect(resumeScheduledSession({ ...deps, companionOn: async () => false }, {
      workstreamId: ws.id, tileId: tile.id, prompt: "P", command: "c", scheduleId: "s", now: 1, revalidate,
    })).rejects.toThrow("archived");
    expect(revalidate.mock.calls.map((c) => c[0])).toEqual(["before-stop", "before-spawn"]);
    expect(log.filter((l) => l.startsWith("spawn"))).toEqual([]);
    expect(spawned.has(tile.id)).toBe(false);
  });
});

describe("a scheduled resume names the session it launches (round 3, finding 2)", () => {
  it("passes the session to both checks and resolves to it", async () => {
    const { ws, tile, deps } = await setup();
    const revalidate = vi.fn(async () => {});
    const launched = await resumeScheduledSession({ ...deps, companionOn: async () => false }, {
      workstreamId: ws.id, tileId: tile.id, prompt: "P", command: "c", scheduleId: "s", now: 1, revalidate,
    });
    expect(launched).toEqual({ sessionId: "session-s" });
    expect(revalidate.mock.calls).toEqual([["before-stop", "session-s"], ["before-spawn", "session-s"]]);
  });
});

describe("resuming an investigation with a digest's follow-up (ADR 045)", () => {
  it("stops the session and resumes it in its tile with the follow-up, recording nothing for the phone", async () => {
    const { backend, ws, tile, deps, log } = await setup();
    await resumeFollowUpSession(deps, { workstreamId: ws.id, tileId: tile.id, prompt: "A new daily digest of CI-Main\nNew failed runs", command: "copilot" });
    expect(log).toEqual([
      "mount:ws:marked",
      "notice:Daily digest follow-up: A new daily digest of CI-Main",
      "intentional",
      "stop",
      "clear:session-s",
      "spawn:/repo/alpha/sub:copilot:session-s:A new daily digest of CI-Main\nNew failed runs",
    ]);
    expect(await backend.companionListSessions()).toEqual([]);
  });

  it("cancels under the tile lock, before stopping anything, when revalidation refuses", async () => {
    const { ws, tile, deps, log } = await setup();
    await expect(resumeFollowUpSession(deps, {
      workstreamId: ws.id, tileId: tile.id, prompt: "Follow up", command: "copilot",
      revalidate: async (phase) => { if (phase === "before-stop") throw new Error("busy"); },
    })).rejects.toThrow("busy");
    expect(log).not.toContain("stop");
    expect(log.some((l) => l.includes("Follow up"))).toBe(false);
  });
});
