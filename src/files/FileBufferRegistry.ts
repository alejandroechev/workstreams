import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type * as MonacoNs from "monaco-editor";

import { type BufferState, type BufferStateContext, INITIAL_CONTEXT, reduce } from "./bufferState";
import { loadMonaco as loadRealMonaco } from "./loadMonaco";

export interface BufferSnapshot {
  path: string;
  state: BufferState;
  dirty: boolean;
  lineEnding: "lf" | "crlf";
  hasTrailingNewline: boolean;
  sniffedBinary: boolean;
  sizeBytes: number;
  lastError?: string;
  conflictingDiskContent?: string;
  conflictingDiskHash?: string;
}

export type BufferListener = (snapshot: BufferSnapshot) => void;

export interface FileBufferRegistry {
  acquire(path: string): Promise<BufferSnapshot>;
  release(path: string): void;
  subscribe(path: string, listener: BufferListener): () => void;
  getSnapshot(path: string): BufferSnapshot | null;
  getModel(path: string): MonacoNs.editor.ITextModel | null;
  save(path: string): Promise<void>;
  resolveConflict(path: string, choice: "keep_mine" | "take_disk"): Promise<void>;
  retrySave(path: string): Promise<void>;
  setAutoSaveEnabled(path: string, enabled: boolean): void;
  listAll(): BufferSnapshot[];
  _disposeAllForTests(): void;
}

export interface RegistryDeps {
  invokeTauri: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listenTauri: <T>(event: string, handler: (ev: { payload: T }) => void) => Promise<() => void>;
  loadMonaco: () => Promise<typeof MonacoNs>;
  autoSaveDebounceMs?: number;
}

type ReadTextFileResult = {
  content: string;
  mtime_unix_ms: number;
  hash_hex: string;
  line_ending: "lf" | "crlf" | "mixed";
  has_trailing_newline: boolean;
  sniffed_binary: boolean;
  size_bytes: number;
};

type WriteTextFileResult = {
  mtime_unix_ms: number;
  hash_hex: string;
};

type FileChangedPayload = {
  mtime_unix_ms: number;
  kind: "modified" | "removed";
};

type Disposable = { dispose: () => void };

type InternalEntry = {
  path: string;
  model: MonacoNs.editor.ITextModel | null;
  stateContext: BufferStateContext;
  listeners: Set<BufferListener>;
  refcount: number;
  lastDiskHash?: string;
  lastDiskMtime?: number;
  lineEnding: "lf" | "crlf";
  hasTrailingNewline: boolean;
  sniffedBinary: boolean;
  sizeBytes: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  autoSaveEnabled: boolean;
  watcherUnsub?: () => void;
  contentChangeDisposable?: Disposable;
  conflictingDiskContent?: string;
  conflictingDiskHash?: string;
  lastError?: string;
};

type ParsedWriteError =
  | { kind: "ExternalModified"; current_hash_hex: string }
  | { kind: "NotFound" }
  | { kind: "PermissionDenied" }
  | { kind: "IsADirectory" }
  | { kind: "DiskFull" }
  | { kind: "Other"; message: string };

const DEFAULT_AUTO_SAVE_DEBOUNCE_MS = 10_000;
const TOO_LARGE_ERROR = "File is too large to edit";
const BINARY_ERROR = "Binary files cannot be edited";

const isDirtyState = (state: BufferState) => state === "dirty" || state === "conflicted" || state === "save_blocked";

// Tauri event names only permit [a-zA-Z0-9-/:_]. We replace any other char
// with `_`. The Rust side has an identical sanitizer (file_io::sanitize_event_name)
// — both must produce the same string for the same canonical path so that
// emit and listen match.
const sanitizeEventName = (s: string): string => s.replace(/[^a-zA-Z0-9\-/:_]/g, "_");

const snapshotFor = (entry: InternalEntry): BufferSnapshot => ({
  path: entry.path,
  state: entry.stateContext.state,
  dirty: isDirtyState(entry.stateContext.state),
  lineEnding: entry.lineEnding,
  hasTrailingNewline: entry.hasTrailingNewline,
  sniffedBinary: entry.sniffedBinary,
  sizeBytes: entry.sizeBytes,
  lastError: entry.lastError ?? entry.stateContext.lastError,
  conflictingDiskContent: entry.conflictingDiskContent,
  conflictingDiskHash: entry.conflictingDiskHash ?? entry.stateContext.conflictingDiskHash,
});

const normalizeReadResult = (result: ReadTextFileResult): ReadTextFileResult & { normalized_line_ending: "lf" | "crlf" } => {
  if (result.line_ending === "mixed") {
    console.warn("Mixed line endings detected; normalizing Monaco buffer to LF.");
    return { ...result, normalized_line_ending: "lf" };
  }
  return { ...result, normalized_line_ending: result.line_ending };
};

const parseWriteError = (error: unknown): ParsedWriteError => {
  const raw = error instanceof Error ? error.message : error;
  const parsed = typeof raw === "string" ? parseMaybeJson(raw) : raw;

  if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
    const err = parsed as { kind?: string; current_hash_hex?: string; message?: string };
    switch (err.kind) {
      case "ExternalModified":
        return { kind: "ExternalModified", current_hash_hex: err.current_hash_hex ?? "" };
      case "NotFound":
        return { kind: "NotFound" };
      case "PermissionDenied":
        return { kind: "PermissionDenied" };
      case "IsADirectory":
        return { kind: "IsADirectory" };
      case "DiskFull":
        return { kind: "DiskFull" };
      case "Other":
        return { kind: "Other", message: err.message ?? "Save failed" };
      default:
        return { kind: "Other", message: err.message ?? JSON.stringify(parsed) };
    }
  }

  switch (parsed) {
    case "not_found":
      return { kind: "NotFound" };
    case "permission_denied":
      return { kind: "PermissionDenied" };
    case "is_directory":
      return { kind: "IsADirectory" };
    case "disk_full":
      return { kind: "DiskFull" };
    default:
      return { kind: "Other", message: String(parsed) };
  }
};

const parseMaybeJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

class FileBufferRegistryImpl implements FileBufferRegistry {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly suppressedTyping = new Set<string>();
  private readonly autoSaveDebounceMs: number;

  constructor(private readonly deps: RegistryDeps) {
    this.autoSaveDebounceMs = deps.autoSaveDebounceMs ?? DEFAULT_AUTO_SAVE_DEBOUNCE_MS;
  }

  async acquire(path: string): Promise<BufferSnapshot> {
    const canonicalPath = await this.canonicalize(path);
    const existing = this.entries.get(canonicalPath);
    if (existing !== undefined) {
      existing.refcount += 1;
      this.notify(existing);
      return snapshotFor(existing);
    }

    const entry = await this.loadEntry(canonicalPath);
    this.entries.set(canonicalPath, entry);
    return snapshotFor(entry);
  }

  release(path: string): void {
    const entry = this.findEntry(path);
    if (entry === undefined) return;

    entry.refcount = Math.max(0, entry.refcount - 1);
    if (entry.refcount === 0 && entry.stateContext.state === "clean") {
      this.disposeEntry(entry);
      this.entries.delete(entry.path);
      return;
    }
    this.notify(entry);
  }

  subscribe(path: string, listener: BufferListener): () => void {
    const entry = this.findEntry(path);
    if (entry === undefined) return () => undefined;

    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  getSnapshot(path: string): BufferSnapshot | null {
    const entry = this.findEntry(path);
    return entry === undefined ? null : snapshotFor(entry);
  }

  getModel(path: string): MonacoNs.editor.ITextModel | null {
    return this.findEntry(path)?.model ?? null;
  }

  async save(path: string): Promise<void> {
    const entry = this.findEntry(path);
    if (entry === undefined || entry.model === null) return;
    if (entry.stateContext.state !== "dirty" && entry.stateContext.state !== "deleted") return;

    this.cancelAutoSave(entry);
    this.dispatch(entry, { type: "save_started" });

    try {
      const result = await this.deps.invokeTauri<WriteTextFileResult>("write_text_file", {
        args: {
          path: entry.path,
          content: entry.model.getValue(),
          expected_hash_hex: entry.lastDiskHash,
          line_ending: entry.lineEnding,
          ensure_trailing_newline: entry.hasTrailingNewline,
        },
      });
      entry.lastDiskHash = result.hash_hex;
      entry.lastDiskMtime = result.mtime_unix_ms;
      entry.conflictingDiskContent = undefined;
      entry.conflictingDiskHash = undefined;
      entry.lastError = undefined;
      this.dispatch(entry, { type: "save_succeeded", newDiskHash: result.hash_hex });
    } catch (error) {
      this.handleSaveError(entry, parseWriteError(error));
    }
  }

  async resolveConflict(path: string, choice: "keep_mine" | "take_disk"): Promise<void> {
    const entry = this.findEntry(path);
    if (entry === undefined) return;

    if (choice === "keep_mine") {
      if (entry.conflictingDiskHash !== undefined) entry.lastDiskHash = entry.conflictingDiskHash;
      entry.conflictingDiskContent = undefined;
      entry.conflictingDiskHash = undefined;
      entry.lastError = undefined;
      this.dispatch(entry, { type: "conflict_resolved_keep_mine" });
      return;
    }

    const disk = normalizeReadResult(await this.deps.invokeTauri<ReadTextFileResult>("read_text_file", { path: entry.path }));
    entry.lastDiskHash = disk.hash_hex;
    entry.lastDiskMtime = disk.mtime_unix_ms;
    entry.lineEnding = disk.normalized_line_ending;
    entry.hasTrailingNewline = disk.has_trailing_newline;
    entry.sniffedBinary = disk.sniffed_binary;
    entry.sizeBytes = disk.size_bytes;
    entry.conflictingDiskContent = undefined;
    entry.conflictingDiskHash = undefined;
    entry.lastError = undefined;
    this.setModelValueSilently(entry, disk.content);
    this.dispatch(entry, { type: "conflict_resolved_take_disk" });
  }

  async retrySave(path: string): Promise<void> {
    const entry = this.findEntry(path);
    if (entry === undefined) return;
    this.dispatch(entry, { type: "user_retry_save" });
    await this.save(entry.path);
  }

  setAutoSaveEnabled(path: string, enabled: boolean): void {
    const entry = this.findEntry(path);
    if (entry === undefined) return;

    entry.autoSaveEnabled = enabled;
    if (!enabled) this.cancelAutoSave(entry);
  }

  listAll(): BufferSnapshot[] {
    return Array.from(this.entries.values(), snapshotFor);
  }

  _disposeAllForTests(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.suppressedTyping.clear();
  }

  private async canonicalize(path: string): Promise<string> {
    return this.deps.invokeTauri<string>("canonicalize_path", { path });
  }

  private async loadEntry(path: string): Promise<InternalEntry> {
    try {
      const read = normalizeReadResult(await this.deps.invokeTauri<ReadTextFileResult>("read_text_file", { path }));
      const entry: InternalEntry = {
        path,
        model: null,
        stateContext: { ...INITIAL_CONTEXT },
        listeners: new Set(),
        refcount: 1,
        lastDiskHash: read.hash_hex,
        lastDiskMtime: read.mtime_unix_ms,
        lineEnding: read.normalized_line_ending,
        hasTrailingNewline: read.has_trailing_newline,
        sniffedBinary: read.sniffed_binary,
        sizeBytes: read.size_bytes,
        debounceTimer: null,
        autoSaveEnabled: true,
        lastError: read.sniffed_binary ? BINARY_ERROR : undefined,
      };

      if (!read.sniffed_binary) {
        await this.attachModel(entry, read.content);
      }
      await this.attachWatcher(entry);
      return entry;
    } catch (error) {
      const lastError = String(error) === "too_large" ? TOO_LARGE_ERROR : String(error);
      return {
        path,
        model: null,
        stateContext: { ...INITIAL_CONTEXT },
        listeners: new Set(),
        refcount: 1,
        lineEnding: "lf",
        hasTrailingNewline: false,
        sniffedBinary: true,
        sizeBytes: 0,
        debounceTimer: null,
        autoSaveEnabled: true,
        lastError,
      };
    }
  }

  private async attachModel(entry: InternalEntry, content: string): Promise<void> {
    const monaco = await this.deps.loadMonaco();
    entry.model = monaco.editor.createModel(content, "plaintext");
    entry.model.setEOL(
      entry.lineEnding === "crlf" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
    );
    entry.contentChangeDisposable = entry.model.onDidChangeContent(() => {
      if (this.suppressedTyping.has(entry.path)) return;
      this.dispatch(entry, { type: "user_typed" });
      if (entry.autoSaveEnabled && entry.stateContext.autoSaveAllowed) this.scheduleAutoSave(entry);
    });
  }

  private async attachWatcher(entry: InternalEntry): Promise<void> {
    await this.deps.invokeTauri<void>("watch_file_changes", { path: entry.path });
    const eventName = `file-changed-${sanitizeEventName(entry.path)}`;
    entry.watcherUnsub = await this.deps.listenTauri<FileChangedPayload>(eventName, (ev) => {
      void this.handleWatcherEvent(entry, ev.payload);
    });
  }

  private async handleWatcherEvent(entry: InternalEntry, payload: FileChangedPayload): Promise<void> {
    if (payload.kind === "removed") {
      this.cancelAutoSave(entry);
      this.dispatch(entry, { type: "external_delete_detected" });
      return;
    }

    const disk = normalizeReadResult(await this.deps.invokeTauri<ReadTextFileResult>("read_text_file", { path: entry.path }));
    if (entry.stateContext.state === "clean") {
      entry.lastDiskHash = disk.hash_hex;
      entry.lastDiskMtime = disk.mtime_unix_ms;
      entry.lineEnding = disk.normalized_line_ending;
      entry.hasTrailingNewline = disk.has_trailing_newline;
      entry.sniffedBinary = disk.sniffed_binary;
      entry.sizeBytes = disk.size_bytes;
      this.setModelValueSilently(entry, disk.content);
      this.notify(entry);
      return;
    }

    if (entry.stateContext.state === "dirty" || entry.stateContext.state === "saving") {
      entry.conflictingDiskContent = disk.content;
      entry.conflictingDiskHash = disk.hash_hex;
      this.cancelAutoSave(entry);
      this.dispatch(
        entry,
        entry.stateContext.state === "saving"
          ? { type: "save_failed_external_modified", currentDiskHash: disk.hash_hex }
          : { type: "external_change_detected" },
      );
    }
  }

  private setModelValueSilently(entry: InternalEntry, content: string): void {
    if (entry.model === null) return;
    this.suppressedTyping.add(entry.path);
    try {
      entry.model.setValue(content);
    } finally {
      this.suppressedTyping.delete(entry.path);
    }
  }

  private scheduleAutoSave(entry: InternalEntry): void {
    this.cancelAutoSave(entry);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      if (entry.autoSaveEnabled && entry.stateContext.autoSaveAllowed) void this.save(entry.path);
    }, this.autoSaveDebounceMs);
  }

  private cancelAutoSave(entry: InternalEntry): void {
    if (entry.debounceTimer !== null) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
  }

  private dispatch(entry: InternalEntry, event: Parameters<typeof reduce>[1]): void {
    const next = reduce(entry.stateContext, event);
    entry.stateContext = next;
    entry.lastError = next.lastError;
    this.notify(entry);
  }

  private handleSaveError(entry: InternalEntry, error: ParsedWriteError): void {
    switch (error.kind) {
      case "ExternalModified":
        entry.conflictingDiskHash = error.current_hash_hex;
        this.dispatch(entry, { type: "save_failed_external_modified", currentDiskHash: error.current_hash_hex });
        break;
      case "NotFound":
        this.dispatch(entry, { type: "save_failed_not_found" });
        break;
      case "PermissionDenied":
        this.dispatch(entry, { type: "save_failed_permission" });
        break;
      case "DiskFull":
        this.dispatch(entry, { type: "save_failed_disk_full" });
        break;
      case "IsADirectory":
        this.dispatch(entry, { type: "save_failed_other", message: "Path is a directory" });
        break;
      case "Other":
        this.dispatch(entry, { type: "save_failed_other", message: error.message });
        break;
    }
  }

  private notify(entry: InternalEntry): void {
    const snapshot = snapshotFor(entry);
    for (const listener of entry.listeners) listener(snapshot);
  }

  private findEntry(path: string): InternalEntry | undefined {
    return this.entries.get(path);
  }

  private disposeEntry(entry: InternalEntry): void {
    this.cancelAutoSave(entry);
    entry.contentChangeDisposable?.dispose();
    entry.watcherUnsub?.();
    void this.deps.invokeTauri<void>("unwatch_file_changes", { path: entry.path });
    entry.model?.dispose();
  }
}

export function createFileBufferRegistry(deps: RegistryDeps): FileBufferRegistry {
  return new FileBufferRegistryImpl(deps);
}

export const fileBufferRegistry: FileBufferRegistry = createFileBufferRegistry({
  invokeTauri: invoke as RegistryDeps["invokeTauri"],
  listenTauri: listen as RegistryDeps["listenTauri"],
  loadMonaco: loadRealMonaco,
});

// Expose a tiny debug bridge for CDP/E2E probes. Single-user desktop app.
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as { __wsFileBufferRegistry?: unknown }).__wsFileBufferRegistry =
    fileBufferRegistry;
}

export default fileBufferRegistry;
