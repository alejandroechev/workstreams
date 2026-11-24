import type { Backend } from "../backend/types";

/**
 * Links a tile to another Copilot session (ADR 033, 044): the new link, the
 * phone thread's revocation and barring the old session's process happen in
 * one native transaction, so a phone message or scheduled run resuming the
 * old session can't slip in between. Returns false, after telling the user,
 * if that failed; the tile is then left exactly as it was.
 */
export async function relinkTile(
  backend: Pick<Backend, "relinkTileSession">,
  tileId: string,
  configJson: string,
  title: string | undefined,
  tell: (message: string) => void,
): Promise<boolean> {
  try {
    await backend.relinkTileSession(tileId, configJson, title);
    return true;
  } catch (error) {
    tell(`The session was not linked: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
