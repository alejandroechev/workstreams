// @test-skip: dev/E2E-only harness scaffolding; exercised via the Playwright harness (real Monaco), not jsdom.
import { createFileBufferRegistry, type FileBufferRegistry, type RegistryDeps } from "../files/FileBufferRegistry";
import { loadMonaco } from "../files/loadMonaco";

/**
 * A {@link FileBufferRegistry} backed by an in-memory string instead of the
 * Tauri filesystem, for the dev/E2E harness. Uses the *real* Monaco loader so
 * the editor renders exactly as in the app (the whole point of the harness is
 * to exercise real Monaco layout/pointer-events, which jsdom can't).
 */
export function makeInMemoryRegistry(path: string, content: string): FileBufferRegistry {
  const store = new Map<string, string>([[path, content]]);
  const enc = new TextEncoder();
  const readResult = (p: string) => {
    const c = store.get(p) ?? "";
    return {
      content: c,
      mtime_unix_ms: Date.now(),
      hash_hex: "0",
      line_ending: "lf" as const,
      has_trailing_newline: c.endsWith("\n"),
      sniffed_binary: false,
      size_bytes: enc.encode(c).length,
    };
  };
  const invokeTauri: RegistryDeps["invokeTauri"] = async <T,>(cmd: string, args?: Record<string, unknown>) => {
    const p = (args?.path as string) ?? path;
    if (cmd === "canonicalize_path") return p as T;
    if (cmd === "read_text_file") return readResult(p) as T;
    if (cmd === "write_text_file") {
      store.set(p, (args?.content as string) ?? store.get(p) ?? "");
      return { mtime_unix_ms: Date.now(), hash_hex: "0" } as T;
    }
    // watch_file_changes / unwatch_file_changes / anything else → no-op.
    return undefined as T;
  };
  return createFileBufferRegistry({
    invokeTauri,
    listenTauri: async () => () => {},
    loadMonaco,
  });
}
