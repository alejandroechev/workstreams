import type { CompanionDoc } from "../companion/doc";
import { emptyLearningDocument, type LearningDocument } from "./protocol";

/**
 * The learning document as the relay uses it (ADR 042). Two implementations:
 * Automerge over the sync server (`fromCompanionDoc` over `openAutomergeDoc`)
 * and an in-memory hub for tests and the browser harness.
 */
export interface LearningDoc {
  read(): LearningDocument;
  subscribe(listener: (doc: LearningDocument) => void): () => void;
  change(mutate: (draft: LearningDocument) => void): void;
  /**
   * Wraps text written into the document. Over Automerge it is one immutable
   * value instead of a character-by-character text history, which would grow
   * the document by every character of every result.
   */
  text(value: string): string;
  broadcast(message: unknown): void;
  onEphemeral(listener: (message: unknown) => void): () => void;
  close(): void;
}

/**
 * The Automerge adapter is shape-agnostic; only its types name the companion.
 * `Immutable` is Automerge's `ImmutableString`, passed in so this module never
 * loads Automerge itself.
 */
export function fromCompanionDoc(doc: CompanionDoc, Immutable: new (value: string) => object): LearningDoc {
  const learning = doc as unknown as Omit<LearningDoc, "text">;
  return {
    read: () => learning.read(),
    subscribe: (listener) => learning.subscribe(listener),
    change: (mutate) => learning.change(mutate),
    text: (value) => new Immutable(value) as unknown as string,
    broadcast: (message) => learning.broadcast(message),
    onEphemeral: (listener) => learning.onEphemeral(listener),
    close: () => learning.close(),
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createInMemoryLearningHub(initial: LearningDocument = emptyLearningDocument()) {
  let state = clone(initial);
  const peers = new Set<{ changes: Set<(doc: LearningDocument) => void>; ephemeral: Set<(m: unknown) => void> }>();
  return {
    peer(): LearningDoc {
      const self = { changes: new Set<(doc: LearningDocument) => void>(), ephemeral: new Set<(m: unknown) => void>() };
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
        text: (value) => value,
        broadcast(message) {
          for (const peer of peers) if (peer !== self) for (const listener of peer.ephemeral) listener(clone(message));
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
