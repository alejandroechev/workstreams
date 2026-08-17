import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackend } from "../backend/context";
import { toRepoRelative } from "../domain/file-types";
import type { SessionFileComment } from "../domain/file-comments";
import { compareByCreatedAt } from "../domain/comment-order";

export interface UseFileCommentsResult {
  comments: SessionFileComment[];
  loading: boolean;
  error: string | null;
  /** The repo-relative file path the comments are keyed on (or null when inert). */
  file: string | null;
  reload: () => Promise<void>;
  add: (
    start: number,
    end: number,
    anchorText: string | null,
    body: string,
  ) => Promise<SessionFileComment>;
  update: (id: string, body: string) => Promise<SessionFileComment>;
  reply: (parentId: string, body: string) => Promise<SessionFileComment>;
  remove: (id: string) => Promise<void>;
  setStatus: (id: string, status: string) => Promise<SessionFileComment>;
}

/**
 * Loads, mutates, and exposes inline file comments for a (workstreamId, file)
 * pair, stored in the bound Copilot session's session.db (unify-commenting).
 * `absolutePath` is converted to a repo-relative path against `rootDir` before
 * hitting the backend, so comments follow the file regardless of the machine's
 * absolute layout.
 *
 * Re-loads on prop change. Add/update/delete/setStatus keep local state in sync
 * without a round-trip. When workstreamId or absolutePath is null/empty, the
 * hook stays empty and inert (no backend calls). A linked session is required:
 * backend calls throw when the workstream has no bound session, surfaced via
 * `error`.
 */
export function useFileComments(
  workstreamId: string | null | undefined,
  rootDir: string | null | undefined,
  absolutePath: string | null | undefined,
): UseFileCommentsResult {
  const backend = useBackend();
  const [commentState, setCommentState] = useState<{
    file: string | null;
    comments: SessionFileComment[];
  }>({ file: null, comments: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadVersionRef = useRef(0);

  const file = useMemo(() => {
    if (!absolutePath) return null;
    return toRepoRelative(rootDir ?? "", absolutePath);
  }, [rootDir, absolutePath]);

  const isActive = Boolean(workstreamId && file !== null);

  const reload = useCallback(async () => {
    const version = ++reloadVersionRef.current;
    if (!workstreamId || file === null) {
      setCommentState({ file: null, comments: [] });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fresh = await backend.listSessionFileComments(workstreamId, file);
      if (version === reloadVersionRef.current) {
        setCommentState({ file, comments: fresh });
      }
    } catch (e) {
      if (version === reloadVersionRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (version === reloadVersionRef.current) setLoading(false);
    }
  }, [backend, workstreamId, file]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sortComments = (list: SessionFileComment[]): SessionFileComment[] => {
    const next = [...list];
    next.sort((a, b) => {
      if (a.anchor_line_start !== b.anchor_line_start) {
        return a.anchor_line_start - b.anchor_line_start;
      }
      return compareByCreatedAt(a, b);
    });
    return next;
  };

  const add = useCallback(
    async (start: number, end: number, anchorText: string | null, body: string) => {
      if (!workstreamId || file === null) {
        throw new Error("workstreamId and a file are required to add a comment");
      }
      // Invalidate any list request that started before this write. Otherwise
      // its stale response can arrive after the INSERT and erase the newly
      // added comment from local state.
      const version = ++reloadVersionRef.current;
      let created: SessionFileComment;
      try {
        created = await backend.addSessionFileComment(
          workstreamId,
          file,
          start,
          end,
          anchorText,
          body,
        );
      } catch (error) {
        if (version === reloadVersionRef.current) {
          setError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
      if (version === reloadVersionRef.current) {
        setError(null);
        setCommentState((previous) => ({
          file,
          comments: sortComments([
            ...(previous.file === file ? previous.comments : []),
            created,
          ]),
        }));
      }
      return created;
    },
    [backend, workstreamId, file],
  );

  const update = useCallback(
    async (id: string, body: string) => {
      if (!workstreamId) throw new Error("workstreamId is required");
      const version = ++reloadVersionRef.current;
      const updated = await backend.updateSessionFileComment(workstreamId, id, body);
      if (version === reloadVersionRef.current) {
        setCommentState((previous) => ({
          ...previous,
          comments: previous.comments.map((comment) =>
            comment.id === id ? updated : comment,
          ),
        }));
      }
      return updated;
    },
    [backend, workstreamId],
  );

  const reply = useCallback(
    async (parentId: string, body: string) => {
      if (!workstreamId) throw new Error("workstreamId is required");
      const version = ++reloadVersionRef.current;
      const created = await backend.replySessionFileComment(workstreamId, parentId, body);
      if (version === reloadVersionRef.current) {
        setCommentState((previous) => ({
          file,
          comments: sortComments([
            ...(previous.file === file ? previous.comments : []),
            created,
          ]),
        }));
      }
      return created;
    },
    [backend, file, workstreamId],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!workstreamId) throw new Error("workstreamId is required");
      const version = ++reloadVersionRef.current;
      await backend.deleteSessionFileComment(workstreamId, id);
      // Cascade replies locally to match the backend delete.
      if (version === reloadVersionRef.current) {
        setCommentState((previous) => ({
          ...previous,
          comments: previous.comments.filter(
            (comment) => comment.id !== id && comment.parent_id !== id,
          ),
        }));
      }
    },
    [backend, workstreamId],
  );

  const setStatus = useCallback(
    async (id: string, status: string) => {
      if (!workstreamId) throw new Error("workstreamId is required");
      const version = ++reloadVersionRef.current;
      const updated = await backend.setSessionFileCommentStatus(workstreamId, id, status);
      if (version === reloadVersionRef.current) {
        setCommentState((previous) => ({
          ...previous,
          comments: previous.comments.map((comment) =>
            comment.id === id ? updated : comment,
          ),
        }));
      }
      return updated;
    },
    [backend, workstreamId],
  );

  return {
    comments:
      isActive && commentState.file === file ? commentState.comments : [],
    loading,
    error,
    file: isActive ? file : null,
    reload,
    add,
    update,
    reply,
    remove,
    setStatus,
  };
}
