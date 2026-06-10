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
import {
  selectionToAnchor,
  formatCommentMeta,
  isMutable,
  estimateZoneHeightInLines,
  type Anchor,
} from "./comments-layer";
import type { FileComment } from "../domain/file-comments";
import { getAppSettings, subscribeAppSettings } from "../domain/app-settings";

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
  /**
   * When false, the internal header (Back / title / Edit) is hidden. The
   * parent is expected to render its own toolbar with equivalent affordances.
   * Defaults to true for back-compat with Workbench / SessionMeta callers.
   */
  showHeader?: boolean;
  /**
   * Called whenever the markdown view state changes so a parent toolbar
   * can render its own preview/edit toggle. Fires `null` when the file
   * isn't a markdown file (no toggle needed) and an object otherwise.
   */
  onViewStateChange?: (state: { mode: "preview" | "edit"; toggle: () => void } | null) => void;
  /**
   * Inline file comments to render as Monaco view zones below their anchor.
   * Only used when `commentsEnabled` is true and the editor is mounted.
   */
  comments?: import("../domain/file-comments").FileComment[];
  /** When true, comment view zones are rendered. */
  commentsEnabled?: boolean;
  /**
   * Add-comment handler. Wired by the parent tile to `useFileComments.add`.
   * Called when the user submits the inline composer.
   */
  onAddComment?: (
    start: number,
    end: number,
    anchorText: string | null,
    bodyMd: string,
  ) => Promise<unknown>;
  /** Update-comment handler. Wired by the parent tile to `useFileComments.update`. */
  onUpdateComment?: (id: string, bodyMd: string) => Promise<unknown>;
  /** Delete-comment handler. Wired by the parent tile to `useFileComments.remove`. */
  onDeleteComment?: (id: string) => Promise<unknown>;
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
  showHeader = true,
  onViewStateChange,
  comments = [],
  commentsEnabled = false,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
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
  // Bumped each time the Monaco editor instance is (re)created so dependent
  // effects can react without polluting the main editor effect.
  const [editorReadyToken, setEditorReadyToken] = useState(0);
  const [selectionAnchor, setSelectionAnchor] = useState<Anchor | null>(null);
  // Composer state: either creating a new comment for a selection, or
  // editing an existing comment in place.
  const [composer, setComposer] = useState<
    | { mode: "create"; anchor: Anchor; body: string }
    | { mode: "edit"; comment: FileComment; body: string }
    | null
  >(null);

  const handleEditClick = useCallback((c: FileComment) => {
    setComposer({ mode: "edit", comment: c, body: c.body_md });
  }, []);

  const handleDeleteClick = useCallback(
    (c: FileComment) => {
      if (!onDeleteComment) return;
      if (!window.confirm("Delete this comment?")) return;
      void onDeleteComment(c.id);
    },
    [onDeleteComment],
  );

  /** Imperatively populate the view-zone DOM node for a comment. */
  function renderCommentZone(node: HTMLDivElement, c: FileComment): void {
    node.innerHTML = "";
    // Monaco's view-zone overlay defaults to pointer-events: none for the
    // surrounding layer; explicitly opt the comment dom into receiving
    // hover + click so the buttons are actually interactive.
    node.style.pointerEvents = "auto";
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "8px";
    header.style.marginBottom = "4px";
    header.style.color = "#a6adc8";
    header.style.fontSize = "10px";
    const meta = document.createElement("span");
    meta.textContent = formatCommentMeta(c);
    if (c.status === "fixed" || c.status === "closed") {
      meta.style.textDecoration = "line-through";
      meta.style.opacity = "0.7";
    }
    header.appendChild(meta);
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    header.appendChild(spacer);
    if (isMutable(c)) {
      const editBtn = document.createElement("button");
      editBtn.textContent = "Edit";
      editBtn.dataset.testid = `comment-edit-${c.id}`;
      Object.assign(editBtn.style, {
        background: "none",
        border: "1px solid #45475a",
        color: "#89b4fa",
        borderRadius: "3px",
        padding: "1px 6px",
        cursor: "pointer",
        fontSize: "10px",
        pointerEvents: "auto",
      });
      editBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        handleEditClick(c);
      });
      header.appendChild(editBtn);
      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.dataset.testid = `comment-delete-${c.id}`;
      Object.assign(delBtn.style, {
        background: "none",
        border: "1px solid #45475a",
        color: "#f38ba8",
        borderRadius: "3px",
        padding: "1px 6px",
        cursor: "pointer",
        fontSize: "10px",
        pointerEvents: "auto",
      });
      delBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        handleDeleteClick(c);
      });
      header.appendChild(delBtn);
    } else if (c.origin_url) {
      const link = document.createElement("a");
      link.href = c.origin_url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "open in ADO";
      link.style.color = "#89b4fa";
      link.style.fontSize = "10px";
      link.style.textDecoration = "none";
      header.appendChild(link);
    }
    node.appendChild(header);
    const body = document.createElement("div");
    body.style.whiteSpace = "pre-wrap";
    body.style.wordBreak = "break-word";
    body.style.lineHeight = "1.5";
    body.textContent = c.body_md;
    node.appendChild(body);
  }


  const snapshot = snapshotState.inputPath === path ? snapshotState.snapshot : null;
  const acquireError = acquireErrorState?.inputPath === path ? acquireErrorState.message : null;
  const editorError =
    editorErrorState?.inputPath === path && editorErrorState.retryToken === editorRetryToken
      ? editorErrorState.message
      : null;
  const localMode = modeState.inputPath === path ? modeState.mode : "preview";
  // Conflict + save_blocked always force the editor so the user can
  // resolve. Plain "dirty" no longer forces edit mode — the user can
  // freely toggle back to preview (it reads from the Monaco model so
  // unsaved changes are still visible).
  const effectiveMode =
    snapshot?.state === "conflicted" || snapshot?.state === "save_blocked"
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
    effectiveMode === "preview";

  const shouldShowEditor = snapshot !== null && !isNonEditable(snapshot) && !shouldShowPreview;
  const editorPath = shouldShowEditor ? snapshot?.path ?? null : null;

  // Notify parent of view state so it can render its own preview/edit
  // toggle in an external toolbar. We only emit toggle availability for
  // markdown files; non-markdown / no-preview-callback files have no
  // toggle to make. The forced edit modes (conflict, save_blocked) emit
  // `null` so the toolbar doesn't show a useless toggle.
  useEffect(() => {
    if (!onViewStateChange) return;
    const isMd = snapshot !== null && renderMarkdownPreview !== undefined && isMarkdown(snapshot.path);
    const isForcedEdit = snapshot?.state === "conflicted" || snapshot?.state === "save_blocked";
    if (!isMd || isForcedEdit) {
      onViewStateChange(null);
      return;
    }
    onViewStateChange({
      mode: effectiveMode,
      toggle: () => setModeState({
        inputPath: path,
        mode: effectiveMode === "preview" ? "edit" : "preview",
      }),
    });
    return () => onViewStateChange(null);
  }, [onViewStateChange, snapshot, effectiveMode, renderMarkdownPreview, path]);

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
          fontSize: getAppSettings().textFontSize,
        });
        editorRef.current = editor;
        setEditorReadyToken((v) => v + 1);

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
      setEditorReadyToken(0);
    };
  }, [editorPath, editorRetryToken, path, registry]);

  // ─── Live font-size updates from global app settings ──────────────────
  useEffect(() => {
    return subscribeAppSettings((s) => {
      const editor = editorRef.current;
      if (editor) editor.updateOptions({ fontSize: s.textFontSize });
    });
  }, [editorReadyToken]);

  // ─── Inline comments: view zones + selection listener ─────────────────
  const zoneIdsRef = useRef<Map<string, string>>(new Map());
  const zoneNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());

  // Rebuild view zones whenever the comment list or enabled state changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      // Editor not mounted yet (or showing markdown preview / error). Tear
      // down any stale zone tracking.
      zoneIdsRef.current.clear();
      zoneNodesRef.current.clear();
      return;
    }
    if (!commentsEnabled) {
      const ids = zoneIdsRef.current;
      if (ids.size > 0) {
        editor.changeViewZones((accessor: MonacoNs.editor.IViewZoneChangeAccessor) => {
          for (const zid of ids.values()) accessor.removeZone(zid);
        });
      }
      ids.clear();
      zoneNodesRef.current.clear();
      return;
    }
    editor.changeViewZones((accessor: MonacoNs.editor.IViewZoneChangeAccessor) => {
      for (const zid of zoneIdsRef.current.values()) accessor.removeZone(zid);
      zoneIdsRef.current.clear();
      zoneNodesRef.current.clear();
      for (const c of comments) {
        const dom = document.createElement("div");
        dom.style.background = "#1e1e2e";
        dom.style.borderTop = "1px solid #313244";
        dom.style.borderBottom = "1px solid #313244";
        dom.style.padding = "6px 12px 8px";
        dom.style.fontFamily = "system-ui, sans-serif";
        dom.style.fontSize = "11px";
        dom.style.color = "#cdd6f4";
        dom.dataset.testid = `comment-zone-${c.id}`;
        dom.dataset.commentId = c.id;
        renderCommentZone(dom, c);
        zoneNodesRef.current.set(c.id, dom);
        const zid = accessor.addZone({
          afterLineNumber: c.anchor_line_end,
          heightInLines: estimateZoneHeightInLines(c.body_md),
          domNode: dom,
          // Let our DOM (with pointer-events: auto) handle mouse events
          // instead of Monaco eating mousedown as a cursor movement.
          suppressMouseDown: true,
        } as MonacoNs.editor.IViewZone);
        zoneIdsRef.current.set(c.id, zid);
      }
    });
    return () => {
      const ed = editorRef.current;
      const ids = zoneIdsRef.current;
      if (ed && ids.size > 0) {
        ed.changeViewZones((accessor: MonacoNs.editor.IViewZoneChangeAccessor) => {
          for (const zid of ids.values()) accessor.removeZone(zid);
        });
      }
      ids.clear();
      zoneNodesRef.current.clear();
    };
  }, [comments, commentsEnabled, editorReadyToken, handleEditClick, handleDeleteClick]);

  // Selection listener -> floating + composer trigger.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !commentsEnabled || !onAddComment) {
      setSelectionAnchor(null);
      return;
    }
    const disposable = editor.onDidChangeCursorSelection?.((e: MonacoNs.editor.ICursorSelectionChangedEvent) => {
      const sel = e.selection;
      if (!sel || sel.isEmpty()) {
        setSelectionAnchor(null);
        return;
      }
      const model = editor.getModel();
      if (!model) return;
      const lines = model.getValue().split(/\r?\n/);
      const anchor = selectionToAnchor(lines, sel.startLineNumber, sel.endLineNumber);
      setSelectionAnchor(anchor);
    });
    return () => disposable?.dispose?.();
  }, [editorReadyToken, commentsEnabled, onAddComment]);

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

  // Toggle stored in a ref so handleKeyDown captures the latest closure
  // without forcing a re-bind on every emit. The effect above already
  // computes the toggle for markdown files; mirror it here so the
  // keyboard shortcut works identically.
  const toggleMarkdownModeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const isMd = snapshot !== null && renderMarkdownPreview !== undefined && isMarkdown(snapshot.path);
    const isForcedEdit = snapshot?.state === "conflicted" || snapshot?.state === "save_blocked";
    if (!isMd || isForcedEdit) {
      toggleMarkdownModeRef.current = null;
      return;
    }
    toggleMarkdownModeRef.current = () => setModeState({
      inputPath: path,
      mode: effectiveMode === "preview" ? "edit" : "preview",
    });
  }, [snapshot, effectiveMode, renderMarkdownPreview, path]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveWithDangerousPathGuard();
      return;
    }
    // VS Code parity: Ctrl+Shift+V toggles markdown preview / edit when the
    // current file is markdown and the host tile provided a preview renderer.
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v") {
      const toggle = toggleMarkdownModeRef.current;
      if (toggle) {
        event.preventDefault();
        toggle();
      }
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
      {showHeader ? (
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
      ) : null}

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

    return (
      <div style={{ position: "relative", height: "100%", width: "100%" }}>
        <div ref={editorHostRef} data-testid="file-editor-monaco" style={{ height: "100%", width: "100%" }} />
        {commentsEnabled && onAddComment && selectionAnchor && !composer ? (
          <button
            data-testid="add-comment-floating"
            onClick={() => setComposer({ mode: "create", anchor: selectionAnchor, body: "" })}
            style={{
              position: "absolute",
              top: 8,
              right: 16,
              padding: "4px 10px",
              background: "#89b4fa",
              color: "#11111b",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
              zIndex: 5,
            }}
          >
            + Comment ({selectionAnchor.start}{selectionAnchor.start !== selectionAnchor.end ? `-${selectionAnchor.end}` : ""})
          </button>
        ) : null}
        {composer ? (
          <div
            data-testid="comment-composer"
            style={{
              position: "absolute",
              top: 8,
              right: 16,
              width: 360,
              background: "#1e1e2e",
              border: "1px solid #45475a",
              borderRadius: 6,
              padding: 10,
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
              zIndex: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 10, color: "#a6adc8" }}>
              {composer.mode === "create"
                ? `Lines ${composer.anchor.start}${composer.anchor.start !== composer.anchor.end ? `-${composer.anchor.end}` : ""}`
                : `Editing comment on line ${composer.comment.anchor_line_start}`}
            </div>
            <textarea
              data-testid="comment-composer-textarea"
              autoFocus
              rows={5}
              value={composer.body}
              onChange={(e) => setComposer((cur) => (cur ? { ...cur, body: e.target.value } : cur))}
              style={{
                background: "#11111b",
                color: "#cdd6f4",
                border: "1px solid #313244",
                borderRadius: 4,
                padding: 6,
                fontFamily: "monospace",
                fontSize: 12,
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <button
                data-testid="comment-composer-cancel"
                onClick={() => setComposer(null)}
                style={{ background: "none", border: "1px solid #45475a", color: "#a6adc8", borderRadius: 4, padding: "3px 10px", cursor: "pointer", fontSize: 11 }}
              >
                Cancel
              </button>
              <button
                data-testid="comment-composer-save"
                disabled={composer.body.trim().length === 0}
                onClick={async () => {
                  const body = composer.body.trim();
                  if (body.length === 0) return;
                  if (composer.mode === "create" && onAddComment) {
                    await onAddComment(
                      composer.anchor.start,
                      composer.anchor.end,
                      composer.anchor.anchorText,
                      body,
                    );
                  } else if (composer.mode === "edit" && onUpdateComment) {
                    await onUpdateComment(composer.comment.id, body);
                  }
                  setComposer(null);
                  setSelectionAnchor(null);
                }}
                style={{
                  background: composer.body.trim().length === 0 ? "#45475a" : "#89b4fa",
                  border: "none",
                  color: "#11111b",
                  borderRadius: 4,
                  padding: "3px 10px",
                  cursor: composer.body.trim().length === 0 ? "not-allowed" : "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
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
