import { describe, it, expect, vi } from "vitest";

import { resolveMetaWatchPaths } from "../meta-watch-paths";

describe("resolveMetaWatchPaths", () => {
  it("includes the workstream directory when there is one", async () => {
    const paths = await resolveMetaWatchPaths({
      workstreamDir: "/Users/me/repo",
      sessionIds: null,
      resolveSessionStateDir: vi.fn(),
    });
    expect(paths).toEqual(["/Users/me/repo"]);
  });

  it("asks the backend for each session-state directory", async () => {
    // The session-state root must come from the backend (which derives it from
    // the real home directory). Building it in the frontend from a guessed
    // home path is what broke this on macOS.
    const resolveSessionStateDir = vi.fn(async (id: string) => `/Users/me/.copilot/session-state/${id}`);

    const paths = await resolveMetaWatchPaths({
      workstreamDir: "/Users/me/repo",
      sessionIds: ["abc", "def"],
      resolveSessionStateDir,
    });

    expect(resolveSessionStateDir).toHaveBeenCalledWith("abc");
    expect(resolveSessionStateDir).toHaveBeenCalledWith("def");
    expect(paths).toEqual([
      "/Users/me/repo",
      "/Users/me/.copilot/session-state/abc",
      "/Users/me/.copilot/session-state/def",
    ]);
  });

  it("never invents a home directory", async () => {
    const resolveSessionStateDir = vi.fn(async (id: string) => `/home/other/.copilot/session-state/${id}`);
    const paths = await resolveMetaWatchPaths({
      workstreamDir: null,
      sessionIds: ["s1"],
      resolveSessionStateDir,
    });
    // Whatever the backend says is the truth — no "C:\Users\..." anywhere.
    expect(paths).toEqual(["/home/other/.copilot/session-state/s1"]);
    expect(paths.some((p) => /^[A-Za-z]:\\/.test(p))).toBe(false);
  });

  it("skips sessions whose directory cannot be resolved", async () => {
    // session_state_dir errors when the folder doesn't exist yet; one bad
    // session must not stop the others from being watched.
    const resolveSessionStateDir = vi.fn(async (id: string) => {
      if (id === "missing") throw new Error("session-state dir not found");
      return `/Users/me/.copilot/session-state/${id}`;
    });

    const paths = await resolveMetaWatchPaths({
      workstreamDir: null,
      sessionIds: ["missing", "ok"],
      resolveSessionStateDir,
    });

    expect(paths).toEqual(["/Users/me/.copilot/session-state/ok"]);
  });

  it("returns an empty list when there is nothing to watch", async () => {
    const paths = await resolveMetaWatchPaths({
      workstreamDir: null,
      sessionIds: [],
      resolveSessionStateDir: vi.fn(),
    });
    expect(paths).toEqual([]);
  });

  it("de-duplicates repeated session ids", async () => {
    const resolveSessionStateDir = vi.fn(async (id: string) => `/s/${id}`);
    const paths = await resolveMetaWatchPaths({
      workstreamDir: null,
      sessionIds: ["a", "a"],
      resolveSessionStateDir,
    });
    expect(paths).toEqual(["/s/a"]);
  });
});
