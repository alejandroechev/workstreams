/**
 * One-line notices for a terminal tile, written by the app rather than its
 * process — e.g. "Resumed from phone: …" (companion conversations). A notice
 * for a tile that hasn't mounted yet waits until it does.
 */
type Listener = (text: string) => void;

const pending = new Map<string, string[]>();
const listeners = new Map<string, Set<Listener>>();

export function postTileNotice(tileId: string, text: string): void {
  const subscribed = listeners.get(tileId);
  if (subscribed && subscribed.size > 0) {
    for (const listener of subscribed) listener(text);
    return;
  }
  pending.set(tileId, [...(pending.get(tileId) ?? []), text]);
}

/** Delivers any waiting notices, then new ones, until unsubscribed. */
export function subscribeTileNotices(tileId: string, listener: Listener): () => void {
  const waiting = pending.get(tileId) ?? [];
  pending.delete(tileId);
  for (const text of waiting) listener(text);
  const set = listeners.get(tileId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(tileId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(tileId);
  };
}
