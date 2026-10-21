/** What stopping a session tile needs from the app. */
export interface StopDeps {
  /** Starts watching for the tile's process to exit; call before writing. */
  watchExit(tileId: string): Promise<{ exited: Promise<void>; dispose(): void }>;
  write(tileId: string, data: string): Promise<void>;
  /** Kills the process if still running and frees the terminal. */
  close(tileId: string): Promise<void>;
  delay(ms: number): Promise<void>;
}

const CTRL_C = "\u0003";

/**
 * Stops a Copilot session before resuming it with a phone message
 * (companion conversations): Ctrl+C twice, which is how Copilot exits, then up
 * to `graceMs` for it to finish writing its session, then a kill. Whatever the
 * session was doing, it ends.
 */
export async function stopSession(
  deps: StopDeps,
  tileId: string,
  options: { graceMs?: number; gapMs?: number; drainMs?: number } = {},
): Promise<{ forced: boolean }> {
  const { graceMs = 5000, gapMs = 150, drainMs = 2000 } = options;
  const watch = await deps.watchExit(tileId);
  try {
    let running = true;
    try {
      await deps.write(tileId, CTRL_C);
      await deps.delay(gapMs);
      await deps.write(tileId, CTRL_C);
    } catch {
      // Nothing to write to: the process is already gone.
      running = false;
    }
    const exited = !running || await Promise.race([
      watch.exited.then(() => true),
      deps.delay(graceMs).then(() => false),
    ]);
    await deps.close(tileId).catch(() => {});
    if (!exited) {
      // Exit events name the tile, not the process: wait for the killed one's
      // event now, or it could arrive later and end the resumed session.
      await Promise.race([watch.exited, deps.delay(drainMs)]);
    }
    return { forced: !exited };
  } finally {
    watch.dispose();
  }
}
