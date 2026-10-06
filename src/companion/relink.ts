import type { Backend } from "../backend/types";

/**
 * Before a tile is linked to another Copilot session: revoke its right to
 * message the phone (ADR 033). Returns false, after telling the user, if that
 * failed; the caller must then leave the tile exactly as it is.
 */
export async function revokeBeforeRelink(
  backend: Pick<Backend, "companionRevokeSession">,
  tileId: string,
  tell: (message: string) => void,
): Promise<boolean> {
  try {
    await backend.companionRevokeSession(tileId);
    return true;
  } catch (error) {
    tell(`The session was not linked: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
