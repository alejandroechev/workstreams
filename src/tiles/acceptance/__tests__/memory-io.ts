// @test-skip: test helper
import { vi } from "vitest";

/** An in-memory acceptance file (compare-and-swap writes), assets and validation folders. */
export function memoryAcceptanceIo(initial: string, opts: { assets?: Record<string, string>; dirs?: Record<string, string[]> } = {}) {
  let text = initial;
  let version = 0;
  const assets = opts.assets ?? {};
  const dirs = opts.dirs ?? {};
  return {
    read: vi.fn(async (path: string) => (path in assets ? { text: assets[path], hash: "asset" } : { text, hash: String(version) })),
    write: vi.fn(async (_path: string, next: string, expected: string) => {
      if (expected !== String(version)) throw Object.assign(new Error("changed"), { kind: "ExternalModified" });
      text = next;
      version += 1;
    }),
    readBase64: vi.fn(async (path: string) => {
      if (!(path in assets)) throw new Error(`missing ${path}`);
      return btoa(assets[path]);
    }),
    listDir: vi.fn(async (path: string) => {
      if (!(path in dirs)) throw new Error(`no dir ${path}`);
      return dirs[path];
    }),
    externalWrite(next: string) { text = next; version += 1; },
    get text() { return text; },
  };
}
