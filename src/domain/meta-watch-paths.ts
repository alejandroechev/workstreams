/**
 * Which directories the Session Meta tile should watch for live updates.
 *
 * The session-state root **must** be resolved by the backend (via the
 * `session_state_dir` command, which uses `dirs::home_dir()`), never
 * constructed in the frontend. This module previously had the home directory
 * hardcoded as `C:\Users\alejandroe`, which silently disabled live refresh for
 * every user who wasn't that author on that machine — and for everyone on
 * macOS/Linux. Failures are per-session and non-fatal, because
 * `session_state_dir` legitimately errors for a session whose folder does not
 * exist yet.
 */
export interface MetaWatchPathsInput {
  /** The workstream's working directory, if it has one. */
  workstreamDir: string | null;
  /** Copilot session ids linked to this tile. */
  sessionIds: string[] | null;
  /** Resolves a session id to its absolute session-state directory. */
  resolveSessionStateDir: (sessionId: string) => Promise<string>;
}

export async function resolveMetaWatchPaths({
  workstreamDir,
  sessionIds,
  resolveSessionStateDir,
}: MetaWatchPathsInput): Promise<string[]> {
  const paths: string[] = [];
  if (workstreamDir) paths.push(workstreamDir);

  for (const sessionId of new Set(sessionIds ?? [])) {
    try {
      const dir = await resolveSessionStateDir(sessionId);
      if (dir && !paths.includes(dir)) paths.push(dir);
    } catch {
      // No session-state folder for this session yet — nothing to watch.
    }
  }

  return paths;
}
