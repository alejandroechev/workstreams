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

/**
 * Text from the phone, made inert for a terminal: every C0 control, DEL and C1
 * control (U+0080–U+009F, which xterm also treats as escapes, e.g. U+009D OSC)
 * becomes a space.
 */
export function terminalSafe(text: string): string {
  return Array.from(text, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : c;
  }).join("");
}

/**
 * A notice stored in a tile's config to show once (`pending_notice`, written
 * natively when a schedule moved to a Periodic session tile, ADR 046), and the
 * config without it; null when there is none.
 */
export function takePendingNotice(configJson: string | undefined): { text: string; configJson: string } | null {
  try {
    const config = JSON.parse(configJson || "{}") as Record<string, unknown>;
    if (typeof config.pending_notice !== "string") return null;
    const { pending_notice: text, ...rest } = config;
    return { text: text as string, configJson: JSON.stringify(rest) };
  } catch {
    return null;
  }
}
