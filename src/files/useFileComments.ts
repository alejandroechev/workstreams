import { useCallback, useEffect, useState } from "react";
import { useBackend } from "../backend/context";
import type { FileComment } from "../domain/file-comments";

export interface UseFileCommentsResult {
  comments: FileComment[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  add: (start: number, end: number, anchorText: string | null, bodyMd: string) => Promise<FileComment>;
  update: (id: string, bodyMd: string) => Promise<FileComment>;
  remove: (id: string) => Promise<void>;
}

/**
 * Loads, mutates, and exposes inline file comments for a (workstreamId, absolutePath)
 * pair. Re-loads on prop change. Add/update/delete keep local state in sync without
 * a round-trip to the backend.
 *
 * When workstreamId or absolutePath is null/empty, the hook stays empty and inert
 * (no backend calls). This lets callers mount the hook before file selection
 * is known without spurious errors.
 */
export function useFileComments(
  workstreamId: string | null | undefined,
  absolutePath: string | null | undefined,
): UseFileCommentsResult {
  const backend = useBackend();
  const [comments, setComments] = useState<FileComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isActive = Boolean(workstreamId && absolutePath);

  const reload = useCallback(async () => {
    if (!workstreamId || !absolutePath) {
      setComments([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fresh = await backend.listFileComments(workstreamId, absolutePath);
      setComments(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [backend, workstreamId, absolutePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(
    async (start: number, end: number, anchorText: string | null, bodyMd: string) => {
      if (!workstreamId || !absolutePath) {
        throw new Error("workstreamId and absolutePath are required to add a comment");
      }
      const created = await backend.addFileComment(workstreamId, absolutePath, start, end, anchorText, bodyMd);
      setComments((prev) => {
        const next = [...prev, created];
        next.sort((a, b) => {
          if (a.anchor_line_start !== b.anchor_line_start) return a.anchor_line_start - b.anchor_line_start;
          return a.created_at.localeCompare(b.created_at);
        });
        return next;
      });
      return created;
    },
    [backend, workstreamId, absolutePath],
  );

  const update = useCallback(
    async (id: string, bodyMd: string) => {
      const updated = await backend.updateFileComment(id, bodyMd);
      setComments((prev) => prev.map((c) => (c.id === id ? updated : c)));
      return updated;
    },
    [backend],
  );

  const remove = useCallback(
    async (id: string) => {
      await backend.deleteFileComment(id);
      setComments((prev) => prev.filter((c) => c.id !== id));
    },
    [backend],
  );

  return {
    comments: isActive ? comments : [],
    loading,
    error,
    reload,
    add,
    update,
    remove,
  };
}
