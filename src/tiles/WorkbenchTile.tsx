// @test-skip: pre-existing tile shell, domain logic tested separately
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import { MarkdownView } from "../ui/MarkdownView";
import { dirnameOf } from "../domain/file-types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useBackend } from "../backend/context";
import { detectLanguage } from "../domain/tile-config";
import { makeAudioBlobUrl } from "../domain/file-types";
import { FileEditorView, type MarkdownViewState } from "../files/FileEditorView";
import type { BufferSnapshot } from "../files/FileBufferRegistry";
import { subscribeAddToWorkbench } from "../domain/workbench-events";
import { workbenchStore } from "../domain/workbench-store-instance";
import { parseViewState } from "../domain/tile-view-state";
import { useTileViewStatePersist } from "../domain/useTileViewStatePersist";
import { FileContextMenu } from "../ui/components/FileContextMenu";
import { ZoomableImage } from "../ui/components/ZoomableImage";
import AudioPlayer from "./AudioPlayer";
import {
  PlusIcon,
  XMarkIcon,
  ChevronUpIcon,
  DocumentIcon,
  DocumentTextIcon,
  CodeBracketIcon,
  FolderOpenIcon,
  MusicalNoteIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { MarkdownModeSelector } from "../ui/components/MarkdownModeSelector";

interface Props {
  tileId: string;
  isFocused: boolean;
  configJson: string;
  onConfigChange: (configJson: string) => void;
  /** Workstream id this tile lives in; used to scope cross-tile add events. */
  workstreamId?: string;
  workstreamVisible?: boolean;
}

type Mode = "list" | "view";

const WORKBENCH_AUDIO_EXTS = new Set(["wav", "mp3", "ogg", "flac"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const BINARY_FALLBACK_EXTS = new Set(["mp4", "mov", "webm", "pdf", "zip", "gz", "tar", "7z", "exe", "dll", "so", "dylib"]);

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

function extensionFor(path: string): string {
  return path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() || "";
}

function isWorkbenchAudioFile(path: string): boolean {
  return WORKBENCH_AUDIO_EXTS.has(extensionFor(path));
}

function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(extensionFor(path));
}

function isBinaryFallbackFile(path: string): boolean {
  return BINARY_FALLBACK_EXTS.has(extensionFor(path));
}

function imageMimeFor(path: string): string {
  return IMAGE_MIME_BY_EXT[extensionFor(path)] ?? "image/png";
}

function FileItemIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "rs": case "py":
      return <CodeBracketIcon style={{ width: 14, height: 14, color: "#a6adc8" }} />;
    case "md": case "mdx": case "markdown":
      return <DocumentTextIcon style={{ width: 14, height: 14, color: "#a6adc8" }} />;
    case "mp3": case "wav": case "ogg": case "flac": case "m4a": case "aac": case "opus": case "webm":
      return <MusicalNoteIcon style={{ width: 14, height: 14, color: "#cba6f7" }} />;
    default:
      return <DocumentIcon style={{ width: 14, height: 14, color: "#6c7086" }} />;
  }
}

export default function WorkbenchTile({ tileId: _tileId, isFocused, configJson, onConfigChange, workstreamId, workstreamVisible = true }: Props) {
  const backend = useBackend();
  const [mode, setMode] = useState<Mode>("list");
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [loadingFile, setLoadingFile] = useState(false);
  // Audio state: when viewingPath points at an audio file, we hold the
  // Blob URL + raw bytes so <AudioPlayer> can render the waveform.
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBytes, setAudioBytes] = useState<ArrayBuffer | null>(null);
  const [audioSize, setAudioSize] = useState(0);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [editorSnapshot, setEditorSnapshot] = useState<BufferSnapshot | null>(null);
  const [editorViewState, setEditorViewState] = useState<MarkdownViewState | null>(null);
  const hydratedRef = useRef(false);

  // Files are sourced from the persistent per-workstream Workbench store
  // (not from tile.config_json anymore). Closing the tile leaves the
  // workstream's list intact; reopening picks it back up.
  const [files, setFiles] = useState<string[]>([]);
  // Paths that don't exist on disk anymore — rendered with a warning badge.
  const [staleFiles, setStaleFiles] = useState<Set<string>>(new Set());

  // Hydrate from the store on mount and whenever the workstream id changes.
  useEffect(() => {
    if (!workstreamId) { setFiles([]); return; }
    let cancelled = false;
    void workbenchStore.list(workstreamId).then((persisted) => {
      if (!cancelled) setFiles(persisted);
    });
    return () => { cancelled = true; };
  }, [workstreamId]);

  // Re-check stale paths whenever the file list changes. Best-effort: any
  // path that throws on stat is treated as missing.
  useEffect(() => {
    if (files.length === 0) { setStaleFiles(new Set()); return; }
    let cancelled = false;
    void Promise.all(files.map(async (p) => {
      try {
        const ok = await invoke<boolean>("path_exists", { path: p });
        return [p, ok] as const;
      } catch {
        return [p, false] as const;
      }
    })).then((results) => {
      if (cancelled) return;
      const stale = new Set<string>();
      for (const [path, ok] of results) if (!ok) stale.add(path);
      setStaleFiles(stale);
    });
    return () => { cancelled = true; };
  }, [files]);

  const persistFiles = useCallback(async (newFiles: string[]) => {
    setFiles(newFiles);
    if (workstreamId) await workbenchStore.set(workstreamId, newFiles);
  }, [workstreamId]);

  // Listen for cross-tile "add to workbench" events. Optimistically
  // refresh the local file list — the dispatcher already persisted to
  // the store, so this is purely a UX shortcut for the mounted tile.
  useEffect(() => {
    return subscribeAddToWorkbench(({ path, workstreamId: targetWsId }) => {
      if (targetWsId && workstreamId && targetWsId !== workstreamId) return;
      setFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
    });
  }, [workstreamId]);

  const handleAddFile = useCallback(async () => {
    try {
      // Dynamic import to avoid issues in test/non-Tauri environments
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({ multiple: true });
      if (!result) return;
      const paths: string[] = Array.isArray(result) ? result : [result];
      const newFiles = [...files];
      for (const filePath of paths) {
        if (!newFiles.includes(filePath)) {
          newFiles.push(filePath);
        }
      }
      await persistFiles(newFiles);
    } catch {
      // Dialog not available (test env) — silently ignore
    }
  }, [files, persistFiles]);

  const handleRemoveFile = useCallback((path: string) => {
    void persistFiles(files.filter((f) => f !== path));
  }, [files, persistFiles]);

  const handleViewFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    setViewingPath(path);
    setMode("view");
    // Reset prior media/editor state (and revoke any object URL we created).
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setAudioBytes(null);
    setAudioSize(0);
    setImageDataUrl(null);
    setEditorSnapshot(null);
    setFileContent("");
    try {
      if (isWorkbenchAudioFile(path)) {
        const b64 = await invoke<string>("read_file_base64", { path });
        const r = makeAudioBlobUrl(path, b64);
        setAudioUrl(r.url);
        setAudioBytes(r.bytes);
        setAudioSize(r.size);
      } else if (isImageFile(path)) {
        const b64 = await invoke<string>("read_file_base64", { path });
        setImageDataUrl(`data:${imageMimeFor(path)};base64,${b64}`);
      } else if (isBinaryFallbackFile(path)) {
        const content = await backend.readFile(path);
        setFileContent(content);
      }
    } catch (e) {
      setFileContent(`Error reading file: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingFile(false);
    }
  }, [backend, audioUrl]);

  const handleBack = useCallback(() => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setAudioBytes(null);
    setImageDataUrl(null);
    setEditorSnapshot(null);
    setMode("list");
    setViewingPath(null);
    setFileContent("");
  }, [audioUrl]);

  useEffect(() => {
    if (!workstreamVisible || hydratedRef.current) return;
    hydratedRef.current = true;
    const vs = parseViewState(configJson, "workbench");
    if (vs.viewingPath) {
      void handleViewFile(vs.viewingPath);
    }
  }, [workstreamVisible, configJson, handleViewFile]);

  useTileViewStatePersist(
    configJson,
    "workbench",
    {
      viewingPath: mode === "view" ? viewingPath ?? undefined : undefined,
      mdViewMode: editorViewState?.mode,
      slideIndex: editorViewState?.mode === "present" ? editorViewState?.slideIndex : undefined,
    },
    onConfigChange,
    { enabled: hydratedRef.current },
  );

  // Watch files for live updates
  useEffect(() => {
    // Watch parent directories of all files in the workbench
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.replace(/\//g, "\\").split("\\");
      parts.pop();
      if (parts.length > 0) dirs.add(parts.join("\\"));
    }
    for (const d of dirs) {
      invoke("watch_directory", { path: d }).catch(() => {});
    }
    const unlisten = listen<{ path: string }>("fs-change", async (event) => {
      if (!workstreamVisible) return;
      const changedPath = event.payload.path.replace(/\//g, "\\");
      // Editable files are watched by FileEditorView; keep this live refresh only
      // for the legacy binary fallback branch.
      if (mode === "view" && viewingPath && isBinaryFallbackFile(viewingPath)) {
        const normalPath = viewingPath.replace(/\//g, "\\");
        if (changedPath === normalPath) {
          try {
            const content = await backend.readFile(viewingPath);
            setFileContent((prev) => prev === content ? prev : content);
          } catch { /* ignore */ }
        }
      }
    });
    return () => {
      for (const d of dirs) {
        invoke("unwatch_directory", { path: d }).catch(() => {});
      }
      unlisten.then((u) => u());
    };
  }, [files, mode, viewingPath, backend, workstreamVisible]);

  const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

  if (mode === "view" && viewingPath) {
    const dirty = editorSnapshot?.dirty === true;
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1e1e2e" }}>
        {/* Slim view toolbar (mirrors Repo Explorer pattern) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            background: "#181825",
            borderBottom: "1px solid #313244",
            flexShrink: 0,
            fontSize: 11,
            fontFamily: "monospace",
            color: "#a6adc8",
          }}
        >
          <button
            onClick={handleBack}
            style={{
              background: "none",
              border: "none",
              color: "#89b4fa",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              padding: "2px 4px",
            }}
            title="Back to file list"
            data-testid="workbench-go-to-list"
          >
            <ChevronUpIcon style={{ width: 14, height: 14 }} />
          </button>
          {dirty ? (
            <span
              data-testid="workbench-dirty-indicator"
              aria-label="Unsaved changes"
              title="Unsaved changes"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#f9e2af", flexShrink: 0 }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#f9e2af" }} />
              *
            </span>
          ) : null}
          <span
            data-testid="workbench-open-file-path"
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, path: viewingPath });
            }}
            title={viewingPath}
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "rtl",
              textAlign: "left",
              color: "#cdd6f4",
              cursor: "context-menu",
            }}
          >
            {viewingPath}
          </span>
          {editorViewState && (
            <MarkdownModeSelector viewState={editorViewState} testIdPrefix="workbench" />
          )}
        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {loadingFile ? (
            <div style={{ padding: 12, color: "#585b70", textAlign: "center", fontFamily: "monospace", fontSize: 12 }}>
              Loading…
            </div>
          ) : audioUrl ? (
            <AudioPlayer
              url={audioUrl}
              path={viewingPath}
              sizeBytes={audioSize}
              audioBytes={audioBytes}
              isFocused={isFocused}
            />
          ) : imageDataUrl ? (
            <ZoomableImage
              testid="workbench-image-preview"
              src={imageDataUrl}
              alt={fileName(viewingPath)}
            />
          ) : isBinaryFallbackFile(viewingPath) ? (
            <Editor
              height="100%"
              language={detectLanguage(viewingPath)}
              value={fileContent}
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                wordWrap: "on",
              }}
            />
          ) : (
            <FileEditorView
              key={viewingPath}
              path={viewingPath}
              onBack={handleBack}
              showHeader={false}
              renderMarkdownPreview={(content) => (
                <MarkdownView
                  basePath={dirnameOf(viewingPath)}
                  onLinkClick={(absPath) => setViewingPath(absPath)}
                >{content}</MarkdownView>
              )}
              onSnapshotChange={setEditorSnapshot}
              onViewStateChange={setEditorViewState}
            />
          )}
        </div>
        {contextMenu && (
          <FileContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            path={contextMenu.path}
            workstreamId={workstreamId ?? null}
            hideAddToWorkbench
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    );
  }

  // List mode
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#1e1e2e",
        color: "#cdd6f4",
        fontFamily: "monospace",
        fontSize: 12,
      }}
    >
      {/* List toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          background: "#181825",
          borderBottom: "1px solid #313244",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#a6adc8", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
          <FolderOpenIcon style={{ width: 14, height: 14 }} />
          Workbench ({files.length})
        </span>
        <button
          onClick={handleAddFile}
          style={{
            background: "#313244",
            border: "none",
            borderRadius: 3,
            color: "#a6e3a1",
            cursor: "pointer",
            fontSize: 11,
            padding: "2px 8px",
            fontFamily: "monospace",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
          title="Add file"
        >
          <PlusIcon style={{ width: 12, height: 12 }} />
          Add File
        </button>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {files.length === 0 && (
          <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
            No files added yet
          </div>
        )}
        {files.map((path) => {
          const isStale = staleFiles.has(path);
          return (
          <div
            key={path}
            data-testid="workbench-file-row"
            data-path={path}
            data-stale={isStale ? "true" : "false"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 8px",
              cursor: "pointer",
              borderBottom: "1px solid #181825",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#313244"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, path });
            }}
          >
            <div
              style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
              onClick={() => handleViewFile(path)}
            >
              {isStale ? (
                <ExclamationTriangleIcon
                  data-testid="workbench-file-stale-icon"
                  style={{ width: 14, height: 14, color: "#f38ba8", flexShrink: 0 }}
                />
              ) : (
                <FileItemIcon name={fileName(path)} />
              )}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: isStale ? "#f38ba8" : "#cdd6f4",
                  textDecoration: isStale ? "line-through" : "none",
                }}
                title={isStale ? `Missing on disk: ${path}` : path}
              >
                {fileName(path)}
              </span>
              <span style={{ color: "#45475a", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>
                {path}
              </span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRemoveFile(path);
              }}
              style={{
                background: "none",
                border: "none",
                color: "#585b70",
                cursor: "pointer",
                padding: "2px",
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
              }}
              title="Remove from workbench"
            >
              <XMarkIcon style={{ width: 14, height: 14 }} />
            </button>
          </div>
          );
        })}
      </div>
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          workstreamId={workstreamId ?? null}
          hideAddToWorkbench
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
