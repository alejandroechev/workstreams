/**
 * A `.excalidraw` file opened in the Repo Explorer (ADR 043): shown as an
 * editable canvas, with edits written back to the file. Writes check the hash
 * last read, so a change made on disk meanwhile is never silently overwritten.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DiagramCanvas } from "./DiagramCanvas";
import { liveElements, parseExcalidrawFile, type DiagramScene } from "./scene";

interface ReadResult {
  content: string;
  hash_hex?: string;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; scene: DiagramScene; raw: Record<string, unknown> };

const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

function isExternalModified(e: unknown): boolean {
  const text = typeof e === "string" ? e : e && typeof e === "object" ? JSON.stringify(e) : "";
  return text.includes("ExternalModified");
}

export function ExcalidrawFileView({ path }: { path: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const hash = useRef<string | null>(null);
  const writing = useRef<Promise<void>>(Promise.resolve());
  // Bumped by every (re)load: edits queued for an older copy of the file are dropped.
  const generation = useRef(0);

  useEffect(() => {
    let alive = true;
    generation.current += 1;
    setState({ kind: "loading" });
    setSaveError(null);
    // Read only after the write in flight settles, so the hash is the file's last.
    writing.current
      .then(() => invoke<ReadResult>("read_diagram_file", { path }))
      .then((read) => {
        if (!alive) return;
        hash.current = read?.hash_hex ?? null;
        const parsed = parseExcalidrawFile(read?.content ?? "");
        if (!parsed.ok) {
          setState({ kind: "error", message: parsed.error });
          return;
        }
        // Parsed above, so this only differs from {} for a real file.
        const raw = (read?.content?.trim() ? JSON.parse(read.content) : {}) as Record<string, unknown>;
        setState({ kind: "ready", scene: parsed.scene, raw });
      })
      .catch((e) => { if (alive) setState({ kind: "error", message: errorText(e) }); });
    return () => { alive = false; };
  }, [path, reloadToken]);

  const raw = state.kind === "ready" ? state.raw : null;
  const save = useCallback((scene: DiagramScene) => {
    const mine = generation.current;
    writing.current = writing.current.then(async () => {
      if (mine !== generation.current) return;
      const elements = liveElements(scene.elements);
      const used = new Set(elements.map((e) => e.fileId).filter((id): id is string => typeof id === "string"));
      // Keep the file's own fields (appState, source, …); only the drawing changes.
      const content = JSON.stringify(
        { type: "excalidraw", version: 2, source: "workstreams", ...(raw ?? {}), elements, files: Object.fromEntries(Object.entries(scene.files).filter(([id]) => used.has(id))) },
        null,
        2,
      );
      try {
        const result = await invoke<{ hash_hex?: string }>("write_text_file", {
          args: { path, content, expected_hash_hex: hash.current, line_ending: "lf", ensure_trailing_newline: true },
        });
        hash.current = result?.hash_hex ?? hash.current;
        setSaveError(null);
      } catch (e) {
        setSaveError({ message: isExternalModified(e) ? "The file changed on disk; your last edit was not saved." : `Could not save: ${errorText(e)}`, conflict: isExternalModified(e) });
      }
    });
  }, [path, raw]);

  if (state.kind === "loading") return <div style={{ padding: 16, color: "#6c7086" }}>Loading…</div>;
  if (state.kind === "error") {
    return <div data-testid="excalidraw-file-error" style={{ padding: 16, color: "#f38ba8" }}>Can't open this file as a diagram: {state.message}</div>;
  }
  return (
    <div data-testid="excalidraw-file-view" style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <DiagramCanvas key={`${path}:${reloadToken}`} registryKey={`file:${path}`} initialScene={state.scene} onSceneChange={save} />
      {saveError && (
        <div data-testid="excalidraw-file-save-error" style={{ position: "absolute", left: 8, bottom: 8, zIndex: 5, padding: "4px 8px", borderRadius: 4, fontSize: 12, background: "#181825", border: "1px solid #f38ba8", color: "#f38ba8", display: "flex", gap: 8, alignItems: "center" }}>
          {saveError.message}
          {saveError.conflict && (
            <button onClick={() => { generation.current += 1; setReloadToken((n) => n + 1); }} style={{ background: "#313244", color: "#cdd6f4", border: "1px solid #45475a", borderRadius: 4, fontSize: 12, cursor: "pointer" }}>
              Reload from disk
            </button>
          )}
        </div>
      )}
    </div>
  );
}
