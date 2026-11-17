/**
 * The Excalidraw canvas used by the Diagram tile and by `.excalidraw` files in
 * the Repo Explorer (ADR 043). It reports scene changes debounced, and only
 * when the drawing itself changed (not on selection, scroll or zoom).
 */
import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { loadExcalidraw } from "./excalidraw-loader";
import type { DiagramScene, SceneElement } from "./scene";

type ExcalidrawModule = Awaited<ReturnType<typeof loadExcalidraw>>;

declare global {
  interface Window {
    /** Open canvases by key (tile board or file path), for CDP/E2E checks. */
    __WS_DIAGRAMS__?: Record<string, ExcalidrawImperativeAPI>;
  }
}

export interface DiagramCanvasProps {
  /** The scene to start from (a function is read once, when the canvas mounts). */
  initialScene: DiagramScene | (() => DiagramScene);
  onSceneChange: (scene: DiagramScene) => void;
  onApi?: (api: ExcalidrawImperativeAPI | null) => void;
  /** Key under which the canvas is listed in `window.__WS_DIAGRAMS__`. */
  registryKey: string;
  debounceMs?: number;
}

/** Changes when elements or image files change, not on view-only updates. */
function sceneVersion(mod: ExcalidrawModule, elements: readonly unknown[], files: Record<string, unknown>): string {
  return `${mod.hashElementsVersion(elements as Parameters<ExcalidrawModule["hashElementsVersion"]>[0])}:${Object.keys(files).length}`;
}

export function DiagramCanvas({ initialScene, onSceneChange, onApi, registryKey, debounceMs = 300 }: DiagramCanvasProps) {
  const [mod, setMod] = useState<ExcalidrawModule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changeRef = useRef(onSceneChange);
  useEffect(() => { changeRef.current = onSceneChange; });
  const pending = useRef<DiagramScene | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const version = useRef<string | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [initial] = useState<DiagramScene>(initialScene);

  useEffect(() => {
    let alive = true;
    loadExcalidraw().then(
      (m) => {
        if (!alive) return;
        version.current = sceneVersion(m, initial.elements, initial.files);
        setMod(m);
      },
      (e) => { if (alive) setError(String(e)); },
    );
    return () => { alive = false; };
  }, [initial]);

  useEffect(() => {
    const flush = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (pending.current) {
        const scene = pending.current;
        pending.current = null;
        changeRef.current(scene);
      }
    };
    return () => {
      flush();
      const registry = window.__WS_DIAGRAMS__;
      if (registry && apiRef.current && registry[registryKey] === apiRef.current) delete registry[registryKey];
      onApi?.(null);
    };
    // The canvas is keyed by its board/file; registryKey never changes for one mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div data-testid="diagram-canvas-error" style={{ padding: 16, color: "#f38ba8" }}>Could not load the diagram editor: {error}</div>;
  if (!mod) return <div data-testid="diagram-canvas-loading" style={{ padding: 16, color: "#6c7086" }}>Loading canvas…</div>;

  const { Excalidraw } = mod;
  return (
    <div data-testid="diagram-canvas" data-diagram-key={registryKey} style={{ position: "absolute", inset: 0 }}>
      <Excalidraw
        theme="dark"
        initialData={{
          elements: initial.elements as never,
          files: initial.files as never,
          appState: { viewBackgroundColor: "#ffffff" },
          scrollToContent: initial.elements.length > 0,
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false } }}
        excalidrawAPI={(api) => {
          apiRef.current = api;
          (window.__WS_DIAGRAMS__ ??= {})[registryKey] = api;
          onApi?.(api);
        }}
        onChange={(elements, _appState, files) => {
          const v = sceneVersion(mod, elements, files as Record<string, unknown>);
          // Loading can normalise the stored elements, which at worst saves the same drawing once.
          if (v === version.current) return;
          version.current = v;
          pending.current = { elements: elements as unknown as SceneElement[], files: { ...(files as Record<string, unknown>) } };
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            const scene = pending.current;
            pending.current = null;
            if (scene) changeRef.current(scene);
          }, debounceMs);
        }}
      />
    </div>
  );
}
