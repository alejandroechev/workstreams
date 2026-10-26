import { useCallback, useEffect, useState } from "react";
import type { Backend } from "../backend/types";
import type { PrInboxSnapshot, PrWatchMode } from "../domain/pr-inbox";
import type { PipelineMode } from "../domain/pipeline-inbox";

export function usePrInbox(backend: Backend) {
  const [snapshot, setSnapshot] = useState<PrInboxSnapshot>({ items: [], repos: [], mutes: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await backend.getPrInbox();
        if (!disposed) {
          setSnapshot(next);
          setError(null);
        }
      } catch (failure) {
        if (!disposed) setError(String(failure instanceof Error ? failure.message : failure));
      } finally {
        if (!disposed) {
          setLoading(false);
          // Local SQLite snapshots only. The native worker polls ADO every two minutes.
          timer = setTimeout(read, 5000);
        }
      }
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [backend, revision]);

  const configure = useCallback(async (projectId: string, mode: PrWatchMode) => {
    await backend.configurePrInbox(projectId, mode);
    setRevision((value) => value + 1);
  }, [backend]);

  const setRead = useCallback(async (id: string, isRead: boolean) => {
    await backend.setPrInboxRead(id, isRead);
    setRevision((value) => value + 1);
  }, [backend]);

  const mute = useCallback(async (id: string) => {
    await backend.mutePrInboxEvent(id);
    setRevision((value) => value + 1);
  }, [backend]);

  const resetMutes = useCallback(async () => {
    const cleared = await backend.resetPrInboxMutes();
    setRevision((value) => value + 1);
    return cleared;
  }, [backend]);

  // Pipelines (ADR 038). Adding asks ADO, so it can take a moment and can fail.
  const addPipeline = useCallback(async (url: string, mode?: PipelineMode) => {
    const added = await backend.addPipelineWatch(url, mode);
    setRevision((value) => value + 1);
    return added;
  }, [backend]);

  const setPipelineMode = useCallback(async (id: string, mode: PipelineMode) => {
    await backend.setPipelineWatchMode(id, mode);
    setRevision((value) => value + 1);
  }, [backend]);

  const removePipeline = useCallback(async (id: string) => {
    await backend.removePipelineWatch(id);
    setRevision((value) => value + 1);
  }, [backend]);

  return { snapshot, error, loading, configure, setRead, mute, resetMutes, addPipeline, setPipelineMode, removePipeline };
}
