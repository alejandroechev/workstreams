import type { NetworkAdapterInterface } from "@automerge/automerge-repo/slim";
import type { CompanionDoc } from "./doc";
import { emptyDocument, type CompanionDocument } from "./protocol";

export interface OpenOptions {
  /** `null` creates a new document (done once, when the companion is enabled). */
  docUrl: string | null;
  /** WebSocket URL of the sync server, token included. Ignored with `network`. */
  wsUrl?: string;
  /** Explicit adapters, for tests. Defaults to a WebSocket client on `wsUrl`. */
  network?: NetworkAdapterInterface[];
  /** Persist locally in IndexedDB so the document survives offline restarts. */
  storage: boolean;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Opens (or creates) the companion document on Automerge Repo 2.x.
 *
 * Loaded lazily and through the `slim` entry with the base64 wasm, so the
 * ~5 MB of Automerge only reaches users who enable the companion, and Vite
 * needs no wasm plugin.
 */
export async function openAutomergeDoc(options: OpenOptions): Promise<{ doc: CompanionDoc; url: string }> {
  const [{ Repo, initializeBase64Wasm }, { automergeWasmBase64 }] = await Promise.all([
    import("@automerge/automerge-repo/slim"),
    import("@automerge/automerge/automerge.wasm.base64"),
  ]);
  await initializeBase64Wasm(automergeWasmBase64);

  let network = options.network;
  if (!network) {
    if (!options.wsUrl) throw new Error("A sync server URL is required");
    const { BrowserWebSocketClientAdapter } = await import("@automerge/automerge-repo-network-websocket");
    network = [new BrowserWebSocketClientAdapter(options.wsUrl)];
  }
  let storage;
  if (options.storage) {
    const { IndexedDBStorageAdapter } = await import("@automerge/automerge-repo-storage-indexeddb");
    storage = new IndexedDBStorageAdapter("workstreams-companion");
  }

  const repo = new Repo({ network, storage });
  const handle = options.docUrl
    ? await repo.find<CompanionDocument>(options.docUrl as Parameters<typeof repo.find>[0])
    : repo.create<CompanionDocument>(emptyDocument());
  await handle.whenReady();

  const offs: Array<() => void> = [];
  const doc: CompanionDoc = {
    read: () => clone(handle.doc() as CompanionDocument),
    subscribe(listener) {
      const on = ({ doc: next }: { doc: CompanionDocument }) => listener(clone(next));
      handle.on("change", on);
      const off = () => handle.off("change", on);
      offs.push(off);
      return off;
    },
    change(mutate) {
      handle.change((draft) => mutate(draft as CompanionDocument));
    },
    broadcast(message) {
      handle.broadcast(message);
    },
    onEphemeral(listener) {
      const on = ({ message }: { message: unknown }) => listener(message);
      handle.on("ephemeral-message", on);
      const off = () => handle.off("ephemeral-message", on);
      offs.push(off);
      return off;
    },
    close() {
      for (const off of offs.splice(0)) off();
      void repo.shutdown();
    },
  };
  return { doc, url: handle.url };
}
