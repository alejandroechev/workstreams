/**
 * An opaque token for "this tile, linked to this Copilot session" (companion
 * conversations). The phone echoes the one it was shown; a tile linked to
 * another session since has a different one, so a message meant for the old
 * session is refused instead of hijacking the new one. Never contains the
 * session id itself.
 */
export async function linkRevision(tileId: string, sessionId: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["workstreams-tile-link", tileId, sessionId]));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}
