import { ArrowLeftIcon, PencilIcon } from "@heroicons/react/24/outline";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type * as MonacoNs from "monaco-editor";

import { ConflictResolutionModal } from "./ConflictResolutionModal";
import {
  fileBufferRegistry,
  type BufferSnapshot,
  type FileBufferRegistry,
} from "./FileBufferRegistry";
import { classifyDangerousPath, type DangerHit } from "./dangerousPaths";
import { loadMonaco } from "./loadMonaco";

const MAX_INLINE_EDIT_SIZE_BYTES = 1024 * 1024;
const confirmedDangerousWarningKeys = new Set<string>();

type ViewMode = "preview" | "edit";

export interface FileEditorViewProps {
  /** Absolute path (NOT yet canonicalized — component will canonicalize via registry.acquire). */
  path: string;
  /** Called when the user clicks the back button (returns to the tile's file list). */
  onBack: () => void;
  /** Markdown rendering callback. If absent, .md files open as plain text. */
  renderMarkdownPreview?: (content: string) => ReactNode;
  /** Override for tests. Defaults to `fileBufferRegistry`. */
  registry?: FileBufferRegistry;
  /** Override for the dangerous-path warning UX. Defaults to window.confirm. */
  showDangerousPathConfirm?: (hit: DangerHit) => Promise<boolean>;
  /** Called whenever the registry snapshot changes, and with null on unmount. */
  onSnapshotChange?: (snapshot: BufferSnapshot | null) => void;
}

import { detectLanguage } from "../domain/tile-config";

/**
 * Resolve the Monaco language id for a file path. Thin wrapper around the
 * shared {@link detectLanguage} map so Repo Explorer, Plan tile, and any
 * future viewer agree on the same mapping (including .cs, .go, .java, etc.).
 */
export function inferLanguage(path: string): string {
  return detectLanguage(path);
}

function defaultDangerousPathConfirm(hit: DangerHit): Promise<boolean> {
  return Promise.resolve(window.confirm(`${hit.reason}\n\nSave anyway?`));
}

function fileNameFor(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function isMarkdown(path: string): boolean {
  const extension = path.split(/[\\/.]/).pop()?.toLowerCase() ?? "";
  return extension === "md" || extension === "markdown";
}

function isNonEditable(snapshot: BufferSnapshot): boolean {
  return snapshot.sniffedBinary || snapshot.sizeBytes > MAX_INLINE_EDIT_SIZE_BYTES;
}

function conflictKeyFor(snapshot: BufferSnapshot): string {
  return [snapshot.path, snapshot.conflictingDiskHash ?? "", snapshot.conflictingDiskContent ?? ""].join("\u0000");
}

export function FileEditorView({
  path,
  onBack,
  renderMarkdownPreview,
  registry = fileBufferRegistry,
  showDangerousPathConfirm = defaultDangerousPathConfirm,
  onSnapshotChange,
}: FileEditorViewProps): ReactElement {
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const canonicalPathRef = useRef<string | null>(null);

  const [snapshotState, setSnapshotState] = useState<{ inputPath: string; snapshot: BufferSnapshot | null }>({
    inputPath: path,
    snapshot: null,
  });
  const [acquireErrorState, setAcquireErrorState] = useState<{ inputPath: string; message: string } | null>(null);
  const [editorErrorState, setEditorErrorState] = useState<{
    inputPath: string;
    retryToken: number;
    message: string;
  } | null>(null);
  const [editorRetryToken, setEditorRetryToken] = useState(0);
  const [modeState, setModeState] = useState<{ inputPath: string; mode: ViewMode }>({ inputPath: path, mode: "preview" });
  const [dismissedConflictKey, setDismissedConflictKey] = useState<string | null>(null);

  const snapshot = snapshotState.inputPath === path ? snapshotState.snapshot : null;
  const acquireError = acquireErrorState?.inputPath === path ? acquireErrorState.message : null;
  const editorError =
    editorErrorState?.inputPath === path && editorErrorState.retryToken === editorRetryToken
      ? editorErrorState.message
      : null;
  const localMode = modeState.inputPath === path ? modeState.mode : "preview";
  const effectiveMode =
    snapshot?.state === "dirty" || snapshot?.state === "conflicted" || snapshot?.state === "save_blocked"
      ? "edit"
      : localMode;
  const conflictKey = snapshot?.state === "conflicted" ? conflictKeyFor(snapshot) : null;

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let releasePath: string | null = null;

    canonicalPathRef.current = null;

    const publishSnapshot = (nextSnapshot: BufferSnapshot) => {
      if (!active) return;
      setSnapshotState({ inputPath: path, snapshot: nextSnapshot });
      onSnapshotChange?.(nextSnapshot);
    };

    registry
      .acquire(path)
      .then((acquiredSnapshot) => {
        if (!active) {
          registry.release(acquiredSnapshot.path);
          return;
        }

        releasePath = acquiredSnapshot.path;
        canonicalPathRef.current = acquiredSnapshot.path;
        publishSnapshot(acquiredSnapshot);

        if (classifyDangerousPath(acquiredSnapshot.path) !== null) {
          registry.setAutoSaveEnabled(acquiredSnapshot.path, false);
        }

        unsubscribe = registry.subscribe(acquiredSnapshot.path, publishSnapshot);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAcquireErrorState({ inputPath: path, message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      active = false;
      unsubscribe?.();
      if (releasePath !== null) registry.release(releasePath);
      canonicalPathRef.current = null;
      onSnapshotChange?.(null);
    };
  }, [onSnapshotChange, path, registry]);

  const shouldShowPreview =
    snapshot !== null &&
    renderMarkdownPreview !== undefined &&
    isMarkdown(snapshot.path) &&
    snapshot.state === "clean" &&
    effectiveMode === "preview";

  const shouldShowEditor = snapshot !== null && !isNonEditable(snapshot) && !shouldShowPreview;
  const editorPath = shouldShowEditor ? snapshot?.path ?? null : null;

  useEffect(() => {
    if (editorPath === null || editorHostRef.current === null) return undefined;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let visibilityObserver: IntersectionObserver | null = null;

    loadMonaco()
      .then((monaco) => {
        if (disposed || editorHostRef.current === null) return;
        const model = registry.getModel(editorPath);
        if (model === null) return;

        monaco.editor.setModelLanguage?.(model, inferLanguage(editorPath));
        const editor = monaco.editor.create(editorHostRef.current, {
          model,
          theme: "vs-dark",
          readOnly: false,
          automaticLayout: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
        });
        editorRef.current = editor;

        resizeObserver = new ResizeObserver(() => editor.layout());
        resizeObserver.observe(editorHostRef.current);

        visibilityObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) editor.layout();
        }, { threshold: 0.01 });
        visibilityObserver.observe(editorHostRef.current);

        editor.layout();
      })
      .catch(() => {
        if (!disposed) setEditorErrorState({ inputPath: path, retryToken: editorRetryToken, message: "Failed to load editor" });
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      visibilityObserver?.disconnect();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [editorPath, editorRetryToken, path, registry]);

  const saveWithDangerousPathGuard = useCallback(async () => {
    const canonicalPath = canonicalPathRef.current;
    if (canonicalPath === null) return;

    const hit = classifyDangerousPath(canonicalPath);
    if (hit !== null && !confirmedDangerousWarningKeys.has(hit.warningKey)) {
      const confirmed = await showDangerousPathConfirm(hit);
      if (!confirmed) return;
      confirmedDangerousWarningKeys.add(hit.warningKey);
    }

    await registry.save(canonicalPath);
  }, [registry, showDangerousPathConfirm]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveWithDangerousPathGuard();
    }
  };

  const handleKeepMine = () => {
    const canonicalPath = canonicalPathRef.current;
    if (canonicalPath === null) return;
    void registry.resolveConflict(canonicalPath, "keep_mine").then(() => registry.save(canonicalPath));
  };

  const handleTakeDisk = () => {
    const canonicalPath = canonicalPathRef.current;
    if (canonicalPath === null) return;
    void registry.resolveConflict(canonicalPath, "take_disk");
  };

  const title = fileNameFor(snapshot?.path ?? path);
  const dirtyMark = snapshot?.dirty ? "*" : "";

  return (
    <div
      data-file-editor-root="true"
      data-testid="file-editor-view"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "#11111b",
        color: "#cdd6f4",
        fontFamily: "monospace",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderBottom: "1px solid #313244",
          padding: "8px 10px",
          flexShrink: 0,
        }}
      >
        <button aria-label="Back" onClick={onBack} style={headerButtonStyle}>
          <ArrowLeftIcon style={{ width: 16, height: 16 }} />
          <span>Back</span>
        </button>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}{dirtyMark}
        </div>
        {shouldShowPreview ? (
          <button aria-label="Edit" onClick={() => setModeState({ inputPath: path, mode: "edit" })} style={headerButtonStyle}>
            <PencilIcon style={{ width: 16, height: 16 }} />
            <span>Edit</span>
          </button>
        ) : null}
      </div>

      <main style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{renderBody()}</main>

      {snapshot !== null ? (
        <ConflictResolutionModal
          open={snapshot.state === "conflicted" && conflictKey !== null && dismissedConflictKey !== conflictKey}
          fileName={fileNameFor(snapshot.path)}
          diskContent={snapshot.conflictingDiskContent ?? ""}
          mineContent={registry.getModel(snapshot.path)?.getValue() ?? ""}
          language={inferLanguage(snapshot.path)}
          onKeepMine={handleKeepMine}
          onTakeDisk={handleTakeDisk}
          onCancel={() => {
            if (conflictKey !== null) setDismissedConflictKey(conflictKey);
          }}
        />
      ) : null}
    </div>
  );

  function renderBody(): ReactNode {
    if (acquireError !== null) {
      return <MessageWithBack message={`Failed to load file: ${acquireError}`} onBack={onBack} />;
    }

    if (snapshot === null) {
      return <div style={messageStyle}>Loading file…</div>;
    }

    if (isNonEditable(snapshot)) {
      return (
        <MessageWithBack
          message="This file is too large or appears to be binary. Open in another editor."
          onBack={onBack}
        />
      );
    }

    if (shouldShowPreview) {
      const content = registry.getModel(snapshot.path)?.getValue() ?? "";
      return <div style={{ height: "100%", overflow: "auto", padding: 16 }}>{renderMarkdownPreview(content)}</div>;
    }

    if (editorError !== null) {
      return (
        <div style={messageStyle}>
          <div>{editorError}</div>
          <button onClick={() => setEditorRetryToken((value) => value + 1)} style={primaryButtonStyle}>
            Retry
          </button>
        </div>
      );
    }

    return <div ref={editorHostRef} data-testid="file-editor-monaco" style={{ height: "100%", width: "100%" }} />;
  }
}

function MessageWithBack({ message, onBack }: { message: string; onBack: () => void }): ReactElement {
  return (
    <div style={messageStyle}>
      <div>{message}</div>
      <button aria-label="Back" onClick={onBack} style={primaryButtonStyle}>
        Back
      </button>
    </div>
  );
}

const headerButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid #45475a",
  borderRadius: 4,
  background: "#1e1e2e",
  color: "#cdd6f4",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "5px 8px",
};

const primaryButtonStyle = {
  border: "none",
  borderRadius: 4,
  background: "#89b4fa",
  color: "#11111b",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "8px 12px",
};

const messageStyle = {
  height: "100%",
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: 24,
  textAlign: "center" as const,
  color: "#a6adc8",
};
