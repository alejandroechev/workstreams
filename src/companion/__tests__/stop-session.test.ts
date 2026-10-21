import { describe, it, expect, vi } from "vitest";
import { stopSession, type StopDeps } from "../stop-session";

function deps(behaviour: "obeys" | "stubborn" | "gone") {
  const log: string[] = [];
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  let ctrlC = 0;
  const d: StopDeps = {
    watchExit: vi.fn(async () => ({ exited, dispose: () => log.push("dispose") })),
    write: vi.fn(async (_tile: string, data: string) => {
      if (behaviour === "gone") throw new Error("no process");
      log.push(`write:${JSON.stringify(data)}`);
      ctrlC += 1;
      if (behaviour === "obeys" && ctrlC === 2) exit();
    }),
    close: vi.fn(async () => { log.push("close"); }),
    delay: vi.fn(async (ms: number) => { log.push(`delay:${ms}`); }),
  };
  return { d, log };
}

describe("stopping a session before resuming it", () => {
  it("sends Ctrl+C twice and moves on as soon as the process exits", async () => {
    const { d, log } = deps("obeys");
    const never = new Promise<void>(() => {});
    d.delay = vi.fn((ms: number) => { log.push(`delay:${ms}`); return ms === 5000 ? never : Promise.resolve(); });
    expect(await stopSession(d, "t1")).toEqual({ forced: false });
    expect(log).toEqual(['write:"\\u0003"', "delay:150", 'write:"\\u0003"', "delay:5000", "close", "dispose"]);
  });

  it("kills a process that ignores Ctrl+C after the grace period", async () => {
    const { d, log } = deps("stubborn");
    expect(await stopSession(d, "t1", { graceMs: 5000 })).toEqual({ forced: true });
    expect(log).toEqual(['write:"\\u0003"', "delay:150", 'write:"\\u0003"', "delay:5000", "close", "delay:2000", "dispose"]);
  });

  it("after a kill, waits for that process's exit event before returning, so it can't end the resumed session", async () => {
    const { d, log } = deps("stubborn");
    let exitNow!: () => void;
    const exited = new Promise<void>((resolve) => { exitNow = resolve; });
    d.watchExit = vi.fn(async () => ({ exited, dispose: () => log.push("dispose") }));
    const never = new Promise<void>(() => {});
    d.delay = vi.fn((ms: number) => { log.push(`delay:${ms}`); return ms === 2000 ? never : Promise.resolve(); });
    d.close = vi.fn(async () => { log.push("close"); setTimeout(() => { log.push("exit"); exitNow(); }, 5); });
    expect(await stopSession(d, "t1")).toEqual({ forced: true });
    expect(log.slice(-3)).toEqual(["delay:2000", "exit", "dispose"]);
  });

  it("does not wait when there is no process to stop", async () => {
    const { d, log } = deps("gone");
    expect(await stopSession(d, "t1")).toEqual({ forced: false });
    expect(log).toEqual(["close", "dispose"]);
  });

  it("always closes, even if closing fails", async () => {
    const { d } = deps("gone");
    d.close = vi.fn(async () => { throw new Error("already closed"); });
    expect(await stopSession(d, "t1")).toEqual({ forced: false });
  });
});
