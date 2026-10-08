// @test-skip: test helper
import { vi } from "vitest";
import type { GrillIo } from "../grill-io";

/** An in-memory grill file with compare-and-swap writes, like the real one. */
export function memoryGrillIo(initial: string, assets: Record<string, string> = {}) {
  let text = initial;
  let version = 0;
  const io = {
    read: vi.fn(async (path: string) => {
      if (path in assets) return { text: assets[path], hash: "asset" };
      return { text, hash: String(version) };
    }),
    write: vi.fn(async (_path: string, next: string, expected: string) => {
      if (expected !== String(version)) throw Object.assign(new Error("changed"), { kind: "ExternalModified" });
      text = next;
      version += 1;
    }),
    readBase64: vi.fn(async (path: string) => {
      if (!(path in assets)) throw new Error(`missing ${path}`);
      return btoa(assets[path]);
    }),
    /** Changes the file as another writer (the agent) would. */
    externalWrite(next: string) { text = next; version += 1; },
    get text() { return text; },
  };
  return io satisfies GrillIo & object;
}
