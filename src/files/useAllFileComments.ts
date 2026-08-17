import { useCallback, useEffect, useRef, useState } from "react";
import { useBackend } from "../backend/context";
import type { SessionFileComment } from "../domain/file-comments";

export interface UseAllFileCommentsResult {
  /** Every comment in the workstream, ordered by file, line, then time. */
  comments: SessionFileComment[];
  loading: boolean;
  error: string | null;
  /**
   * True when the failure was specifically "no linked Copilot session".
   * Split out from `error` so the Comments tab can show the same actionable
   * prompt the comment toggle uses instead of a raw backend message.
   */
  unbound: boolean;
  reload: () => Promise<void>;
}

/** The backend rejects with this phrasing when a workstream has no session. */
function isUnboundError(message: string): boolean {
  return /linked Copilot session|no Copilot session/i.test(message);
}

/**
 * Loads **every** inline comment for a workstream, across all files — the data
 * behind the Repo Explorer Comments tab.
 *
 * Sibling of `useFileComments`, which is per-file and owns mutations. This hook
 * is read-only on purpose: the tab's left pane is navigation-only, and every
 * mutation stays in the editor's view zone so there is a single code path for
 * status changes.
 *
 * Ordering comes from the backend (SQL / the in-memory stub's mirror of it), so
 * legacy epoch-second rows interleave correctly with ISO-8601 ones.
 *
 * There is no polling by design (ADR 009): the agent writes to session.db
 * out-of-band, so freshness is the caller's call via `reload()`.
 */
export function useAllFileComments(
  workstreamId: string | null | undefined,
): UseAllFileCommentsResult {
  const backend = useBackend();
  const [comments, setComments] = useState<SessionFileComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unbound, setUnbound] = useState(false);
  // Guards against a slow earlier request resolving after a newer one and
  // overwriting fresher state (same pattern as useFileComments).
  const reloadVersionRef = useRef(0);

  const reload = useCallback(async () => {
    const version = ++reloadVersionRef.current;
    if (!workstreamId) {
      setComments([]);
      setError(null);
      setUnbound(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fresh = await backend.listAllSessionFileComments(workstreamId);
      if (version !== reloadVersionRef.current) return;
      setComments(fresh);
      setUnbound(false);
    } catch (e) {
      if (version !== reloadVersionRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      setComments([]);
      if (isUnboundError(message)) {
        setUnbound(true);
        setError(null);
      } else {
        setUnbound(false);
        setError(message);
      }
    } finally {
      if (version === reloadVersionRef.current) setLoading(false);
    }
  }, [backend, workstreamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { comments, loading, error, unbound, reload };
}
