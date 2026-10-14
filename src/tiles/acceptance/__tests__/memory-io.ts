// @test-skip: test helper
import { vi } from "vitest";

/** An in-memory acceptance file (compare-and-swap writes), assets and validation folders. */
export function memoryAcceptanceIo(initial: string, opts: { assets?: Record<string, string>; dirs?: Record<string, string[]> } = {}) {
  let text = initial;
  let version = 0;
  const assets = opts.assets ?? {};
  const dirs = opts.dirs ?? {};
  const modified: Record<string, number> = {};
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
    listEntries: vi.fn(async (path: string) => {
      const prefix = `${path}/`;
      const names = Object.keys(assets).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
      return names.map((p) => ({ name: p.slice(prefix.length), modified: modified[p] ?? 0 }));
    }),
    externalWrite(next: string) { text = next; version += 1; },
    /** Rewrites an asset in place, as the agent redrawing a frame would. */
    rewriteAsset(path: string, content: string) { assets[path] = content; modified[path] = (modified[path] ?? 0) + 1; },
    get text() { return text; },
  };
}
