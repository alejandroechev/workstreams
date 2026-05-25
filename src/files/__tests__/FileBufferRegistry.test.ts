import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFileBufferRegistry, type RegistryDeps } from "../FileBufferRegistry";

type ReadResponse = {
  content: string;
  mtime_unix_ms: number;
  hash_hex: string;
  line_ending: "lf" | "crlf" | "mixed";
  has_trailing_newline: boolean;
  sniffed_binary: boolean;
  size_bytes: number;
};

type Listener = () => void;
type WatchPayload = { mtime_unix_ms: number; kind: "modified" | "removed" };

class FakeModel {
  private value: string;
  private listeners = new Set<Listener>();
  public disposed = false;
  public eol: number | null = null;
  public setValueCalls: string[] = [];

  constructor(value: string) {
    this.value = value;
  }

  getValue() {
    return this.value;
  }

  setValue(value: string) {
    this.value = value;
    this.setValueCalls.push(value);
    for (const listener of this.listeners) listener();
  }

  onDidChangeContent(listener: Listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  setEOL(eol: number) {
    this.eol = eol;
  }

  dispose() {
    this.disposed = true;
  }
}

const canonical = "C:\\repo\\file.txt";
const secondCanonical = "C:\\repo\\other.txt";

const readResponse = (overrides: Partial<ReadResponse> = {}): ReadResponse => ({
  content: "hello\n",
  mtime_unix_ms: 10,
  hash_hex: "hash-1",
  line_ending: "lf",
  has_trailing_newline: true,
  sniffed_binary: false,
  size_bytes: 6,
  ...overrides,
});

const createHarness = () => {
  const models: FakeModel[] = [];
  const watchHandlers = new Map<string, (ev: { payload: WatchPayload }) => void>();
  const unlisten = vi.fn();
  const readQueue: Array<ReadResponse | string> = [readResponse()];
  const writeQueue: Array<{ mtime_unix_ms: number; hash_hex: string } | unknown> = [
    { mtime_unix_ms: 20, hash_hex: "hash-2" },
  ];

  const invokeTauri = vi.fn(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd === "canonicalize_path") {
      const path = String(args?.path);
      return (path.includes("other") ? secondCanonical : canonical) as T;
    }
    if (cmd === "read_text_file") {
      const next = readQueue.shift() ?? readResponse();
      if (typeof next === "string") throw next;
      return next as T;
    }
    if (cmd === "write_text_file") {
      const next = writeQueue.shift() ?? { mtime_unix_ms: 30, hash_hex: "hash-next" };
      if (next instanceof Error) throw next;
      if (typeof next === "object" && next !== null && "kind" in next) throw next;
      return next as T;
    }
    if (cmd === "watch_file_changes" || cmd === "unwatch_file_changes") return undefined as T;
    throw new Error(`unexpected command ${cmd}`);
  });

  const listenTauri: RegistryDeps["listenTauri"] = vi.fn(async (event, handler) => {
    watchHandlers.set(event, handler as (ev: { payload: WatchPayload }) => void);
    return unlisten;
  });

  const monaco = {
    editor: {
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      createModel: vi.fn((content: string) => {
        const model = new FakeModel(content);
        models.push(model);
        return model;
      }),
    },
  };

  const deps: RegistryDeps = {
    invokeTauri: invokeTauri as RegistryDeps["invokeTauri"],
    listenTauri,
    loadMonaco: vi.fn(async () => monaco as never),
    autoSaveDebounceMs: 25,
  };
  const registry = createFileBufferRegistry(deps);

  return { registry, invokeTauri, listenTauri, watchHandlers, unlisten, readQueue, writeQueue, models, monaco };
};

const watcherEvent = (harness: ReturnType<typeof createHarness>, path = canonical) => `file-changed-${path}`;

describe("FileBufferRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("acquires a file from disk and returns a clean snapshot", async () => {
    const h = createHarness();

    const snapshot = await h.registry.acquire("file.txt");

    expect(snapshot).toMatchObject({ path: canonical, state: "clean", dirty: false, lineEnding: "lf" });
    expect(h.invokeTauri).toHaveBeenCalledWith("canonicalize_path", { path: "file.txt" });
    expect(h.invokeTauri).toHaveBeenCalledWith("read_text_file", { path: canonical });
    expect(h.monaco.editor.createModel).toHaveBeenCalledWith("hello\n", "plaintext");
    expect(h.models[0].eol).toBe(0);
  });

  it("acquires the same canonical file once and increments refcount", async () => {
    const h = createHarness();

    await h.registry.acquire("file.txt");
    await h.registry.acquire("file.txt");

    expect(h.monaco.editor.createModel).toHaveBeenCalledTimes(1);
    expect(h.invokeTauri.mock.calls.filter(([cmd]) => cmd === "read_text_file")).toHaveLength(1);
    h.registry.release(canonical);
    expect(h.registry.getSnapshot(canonical)).not.toBeNull();
  });

  it("releases clean buffers and disposes on the final release", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");
    await h.registry.acquire("file.txt");

    h.registry.release(canonical);
    expect(h.models[0].disposed).toBe(false);
    h.registry.release(canonical);

    expect(h.models[0].disposed).toBe(true);
    expect(h.unlisten).toHaveBeenCalled();
    expect(h.invokeTauri).toHaveBeenCalledWith("unwatch_file_changes", { path: canonical });
    expect(h.registry.getSnapshot(canonical)).toBeNull();
  });

  it("marks buffers dirty when the model changes and starts auto-save", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");

    h.models[0].setValue("changed\n");

    expect(h.registry.getSnapshot(canonical)?.state).toBe("dirty");
    await vi.advanceTimersByTimeAsync(24);
    expect(h.invokeTauri.mock.calls.filter(([cmd]) => cmd === "write_text_file")).toHaveLength(0);
  });

  it("auto-saves after the debounce and returns clean", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");
    h.models[0].setValue("changed\n");

    await vi.advanceTimersByTimeAsync(25);

    expect(h.invokeTauri).toHaveBeenCalledWith("write_text_file", {
      args: {
        path: canonical,
        content: "changed\n",
        expected_hash_hex: "hash-1",
        line_ending: "lf",
        ensure_trailing_newline: true,
      },
    });
    expect(h.registry.getSnapshot(canonical)?.state).toBe("clean");
  });

  it("explicit save before debounce cancels pending auto-save", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");
    h.models[0].setValue("changed\n");

    await h.registry.save(canonical);
    await vi.advanceTimersByTimeAsync(25);

    expect(h.invokeTauri.mock.calls.filter(([cmd]) => cmd === "write_text_file")).toHaveLength(1);
  });

  it("moves to conflicted when save reports ExternalModified", async () => {
    const h = createHarness();
    h.writeQueue[0] = { kind: "ExternalModified", current_hash_hex: "disk-hash" };
    const listener = vi.fn();
    await h.registry.acquire("file.txt");
    h.registry.subscribe(canonical, listener);
    h.models[0].setValue("changed\n");

    await h.registry.save(canonical);

    expect(h.registry.getSnapshot(canonical)).toMatchObject({ state: "conflicted", conflictingDiskHash: "disk-hash" });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ state: "conflicted" }));
  });

  it("resolves keep_mine by returning to dirty and using the conflict hash", async () => {
    const h = createHarness();
    h.writeQueue[0] = { kind: "ExternalModified", current_hash_hex: "disk-hash" };
    await h.registry.acquire("file.txt");
    h.models[0].setValue("changed\n");
    await h.registry.save(canonical);

    await h.registry.resolveConflict(canonical, "keep_mine");
    h.writeQueue.push({ mtime_unix_ms: 40, hash_hex: "hash-4" });
    await h.registry.save(canonical);

    expect(h.registry.getSnapshot(canonical)?.state).toBe("clean");
    expect(h.invokeTauri).toHaveBeenLastCalledWith("write_text_file", expect.objectContaining({
      args: expect.objectContaining({ expected_hash_hex: "disk-hash" }),
    }));
  });

  it("resolves take_disk by reloading without marking dirty", async () => {
    const h = createHarness();
    h.writeQueue[0] = { kind: "ExternalModified", current_hash_hex: "disk-hash" };
    h.readQueue.push(readResponse({ content: "disk\n", hash_hex: "disk-hash", mtime_unix_ms: 50 }));
    await h.registry.acquire("file.txt");
    h.models[0].setValue("mine\n");
    await h.registry.save(canonical);

    await h.registry.resolveConflict(canonical, "take_disk");

    expect(h.models[0].getValue()).toBe("disk\n");
    expect(h.registry.getSnapshot(canonical)?.state).toBe("clean");
  });

  it("silently reloads watcher modifications while clean", async () => {
    const h = createHarness();
    h.readQueue.push(readResponse({ content: "new disk\n", hash_hex: "hash-new" }));
    await h.registry.acquire("file.txt");

    h.watchHandlers.get(watcherEvent(h))?.({ payload: { kind: "modified", mtime_unix_ms: 99 } });
    await Promise.resolve();

    expect(h.models[0].getValue()).toBe("new disk\n");
    expect(h.registry.getSnapshot(canonical)?.state).toBe("clean");
  });

  it("turns watcher modifications while dirty into conflicts with disk content", async () => {
    const h = createHarness();
    h.readQueue.push(readResponse({ content: "disk\n", hash_hex: "disk-hash" }));
    await h.registry.acquire("file.txt");
    h.models[0].setValue("mine\n");

    h.watchHandlers.get(watcherEvent(h))?.({ payload: { kind: "modified", mtime_unix_ms: 99 } });
    await Promise.resolve();

    expect(h.registry.getSnapshot(canonical)).toMatchObject({
      state: "conflicted",
      conflictingDiskContent: "disk\n",
      conflictingDiskHash: "disk-hash",
    });
  });

  it("marks the buffer deleted when the watcher reports removal", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");

    h.watchHandlers.get(watcherEvent(h))?.({ payload: { kind: "removed", mtime_unix_ms: 0 } });

    expect(h.registry.getSnapshot(canonical)?.state).toBe("deleted");
  });

  it("keeps deleted when saving a deleted buffer reports NotFound", async () => {
    const h = createHarness();
    h.writeQueue[0] = { kind: "NotFound" };
    await h.registry.acquire("file.txt");
    h.watchHandlers.get(watcherEvent(h))?.({ payload: { kind: "removed", mtime_unix_ms: 0 } });

    await h.registry.save(canonical);

    expect(h.registry.getSnapshot(canonical)?.state).toBe("deleted");
  });

  it("moves to save_blocked for permission errors", async () => {
    const h = createHarness();
    h.writeQueue[0] = { kind: "PermissionDenied" };
    await h.registry.acquire("file.txt");
    h.models[0].setValue("changed\n");

    await h.registry.save(canonical);

    expect(h.registry.getSnapshot(canonical)).toMatchObject({ state: "save_blocked", lastError: "Permission denied" });
  });

  it("retrySave transitions from save_blocked and saves immediately", async () => {
    const h = createHarness();
    h.writeQueue[0] = { kind: "PermissionDenied" };
    h.writeQueue.push({ mtime_unix_ms: 40, hash_hex: "hash-4" });
    await h.registry.acquire("file.txt");
    h.models[0].setValue("changed\n");
    await h.registry.save(canonical);

    await h.registry.retrySave(canonical);

    expect(h.registry.getSnapshot(canonical)?.state).toBe("clean");
    expect(h.invokeTauri.mock.calls.filter(([cmd]) => cmd === "write_text_file")).toHaveLength(2);
  });

  it("registers sniffed binary files without creating Monaco models", async () => {
    const h = createHarness();
    h.readQueue[0] = readResponse({ content: "", sniffed_binary: true, size_bytes: 100 });

    const snapshot = await h.registry.acquire("file.txt");

    expect(snapshot).toMatchObject({ sniffedBinary: true, sizeBytes: 100 });
    expect(h.monaco.editor.createModel).not.toHaveBeenCalled();
    expect(h.registry.getModel(canonical)).toBeNull();
  });

  it("registers too_large read failures as non-editable snapshots", async () => {
    const h = createHarness();
    h.readQueue[0] = "too_large";

    const snapshot = await h.registry.acquire("file.txt");

    expect(snapshot).toMatchObject({ sniffedBinary: true, lastError: "File is too large to edit", sizeBytes: 0 });
    expect(h.registry.getModel(canonical)).toBeNull();
  });

  it("lists all loaded buffers", async () => {
    const h = createHarness();
    h.readQueue.push(readResponse({ content: "other\n", hash_hex: "hash-other" }));

    await h.registry.acquire("file.txt");
    await h.registry.acquire("other.txt");

    expect(h.registry.listAll().map((snapshot) => snapshot.path).sort()).toEqual([canonical, secondCanonical].sort());
  });

  it("preserves dirty buffers after their final release", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");
    h.models[0].setValue("changed\n");

    h.registry.release(canonical);

    expect(h.registry.getSnapshot(canonical)?.state).toBe("dirty");
    expect(h.models[0].disposed).toBe(false);
  });

  it("notifies listeners on every state transition", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");
    const listener = vi.fn();
    h.registry.subscribe(canonical, listener);

    h.models[0].setValue("changed\n");
    await h.registry.save(canonical);

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ state: "dirty" }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ state: "saving" }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ state: "clean" }));
  });

  it("unsubscribe stops future notifications", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");
    const listener = vi.fn();
    const unsubscribe = h.registry.subscribe(canonical, listener);

    unsubscribe();
    h.models[0].setValue("changed\n");

    expect(listener).not.toHaveBeenCalled();
  });

  it("disposes every loaded buffer for tests", async () => {
    const h = createHarness();
    await h.registry.acquire("file.txt");
    h.readQueue.push(readResponse({ content: "other\n", hash_hex: "hash-other" }));
    await h.registry.acquire("other.txt");

    h.registry._disposeAllForTests();

    expect(h.models.every((model) => model.disposed)).toBe(true);
    expect(h.registry.listAll()).toEqual([]);
  });

  it("normalizes mixed line endings to LF and warns once", async () => {
    const h = createHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.readQueue[0] = readResponse({ content: "a\r\nb\n", line_ending: "mixed" });

    const snapshot = await h.registry.acquire("file.txt");

    expect(snapshot.lineEnding).toBe("lf");
    expect(h.models[0].eol).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
