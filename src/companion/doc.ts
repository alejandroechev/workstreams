import { emptyDocument, type CompanionDocument, type PresenceMessage } from "./protocol";

/**
 * The companion document as both apps use it (ADR 033). Two implementations:
 * Automerge over the sync server (`automerge-doc.ts`), and an in-memory hub
 * for tests, the browser harness and the CLI scenario. Everything above this
 * interface (publisher, executor, UI) is written against it only.
 */
export interface CompanionDoc {
  /** A plain copy of the current document; mutating it changes nothing. */
  read(): CompanionDocument;
  /** Called with a plain copy after every change, local or remote. */
  subscribe(listener: (doc: CompanionDocument) => void): () => void;
  /** The only way to write. `mutate` may change the draft in place. */
  change(mutate: (draft: CompanionDocument) => void): void;
  /** Sends an ephemeral message to the other peers; never stored. */
  broadcast(message: PresenceMessage): void;
  onEphemeral(listener: (message: unknown) => void): () => void;
  close(): void;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Peers of one in-memory document, standing in for the sync server. */
export function createInMemoryHub(initial: CompanionDocument = emptyDocument()) {
  let state = clone(initial);
  const peers = new Set<{
    changes: Set<(doc: CompanionDocument) => void>;
    ephemeral: Set<(message: unknown) => void>;
  }>();

  return {
    peer(): CompanionDoc {
      const self = { changes: new Set<(doc: CompanionDocument) => void>(), ephemeral: new Set<(message: unknown) => void>() };
      peers.add(self);
      return {
        read: () => clone(state),
        subscribe(listener) {
          self.changes.add(listener);
          return () => self.changes.delete(listener);
        },
        change(mutate) {
          const draft = clone(state);
          mutate(draft);
          state = draft;
          for (const peer of peers) for (const listener of peer.changes) listener(clone(state));
        },
        broadcast(message) {
          for (const peer of peers) {
            if (peer === self) continue;
            for (const listener of peer.ephemeral) listener(clone(message));
          }
        },
        onEphemeral(listener) {
          self.ephemeral.add(listener);
          return () => self.ephemeral.delete(listener);
        },
        close() {
          self.changes.clear();
          self.ephemeral.clear();
          peers.delete(self);
        },
      };
    },
  };
}
