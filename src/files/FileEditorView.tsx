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
import ReactDOM from "react-dom/client";
import { splitSlides } from "../domain/slides";
import {
  fileBufferRegistry,
  type BufferSnapshot,
  type FileBufferRegistry,
} from "./FileBufferRegistry";
import { classifyDangerousPath, type DangerHit } from "./dangerousPaths";
import { ZoomableImage } from "../ui/components/ZoomableImage";
import { MarkdownView } from "../ui/MarkdownView";
import { SlideDeck } from "../ui/components/SlideDeck";
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

export type ViewMode = "preview" | "edit" | "present";

/**
 * View-state descriptor emitted to host tiles so they can render an external
 * toolbar with a three-way mode selector (Edit / Preview / Slides). Shared so
 * the three markdown-hosting tiles (Repo Explorer, Workbench, Session Meta)
 * all type their `editorViewState` identically.
 */
export interface MarkdownViewState {
  mode: ViewMode;
  /** Jump directly to a specific mode. `present` is ignored unless canPresent. */
  setMode: (mode: ViewMode) => void;
  /** Swap preview⇄edit (from present, returns to preview). */
  toggle: () => void;
  /** True for markdown files (present is markdown-only). */
  canPresent: boolean;
  enterPresent: () => void;
  exitPresent: () => void;
  slideIndex: number;
  setSlideIndex: (index: number) => void;
}

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
   * can render its own preview/edit toggle and Present button. Fires `null`
   * when the file isn't a markdown/svg file (no toggle needed).
   * - `toggle` swaps preview⇄edit (from present it returns to preview).
   * - `canPresent` is true for markdown files; `enterPresent`/`exitPresent`
   *   drive the third mode, and `slideIndex`/`setSlideIndex` reflect/persist
   *   the current slide.
   */
  onViewStateChange?: (state: MarkdownViewState | null) => void;
  /** Initial view mode to restore from persisted tile state (default preview). */
  initialViewMode?: "preview" | "edit" | "present";
  /** Initial slide index to restore when starting in present mode. */
  initialSlideIndex?: number;
  /**
   * 1-based line to reveal + select once the Monaco editor mounts (e.g. when
   * opened from a content-search result). Applied once per editor mount; has no
   * effect for files that open in a non-editor preview (markdown/SVG/image).
   */
  initialRevealLine?: number | null;
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

/** Directory portion of a path (for resolving relative slide images). */
function dirnameForPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? "" : path.slice(0, idx);
}

function isMarkdown(path: string): boolean {
  const extension = path.split(/[\\/.]/).pop()?.toLowerCase() ?? "";
  return extension === "md" || extension === "markdown";
}

function isSvg(path: string): boolean {
  return (path.split(/[\\/.]/).pop()?.toLowerCase() ?? "") === "svg";
}

/** Build a data URL for rendering SVG source as an image (no script exec). */
function svgDataUrl(content: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(content)}`;
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
  initialViewMode,
  initialSlideIndex,
  initialRevealLine,
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
  const [modeState, setModeState] = useState<{ inputPath: string; mode: ViewMode }>({ inputPath: path, mode: initialViewMode ?? "preview" });
  const [slideState, setSlideState] = useState<{ inputPath: string; index: number }>({ inputPath: path, index: initialSlideIndex ?? 0 });
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
  const localSlideIndex = slideState.inputPath === path ? slideState.index : 0;
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
    effectiveMode === "preview" &&
    ((renderMarkdownPreview !== undefined && isMarkdown(snapshot.path)) || isSvg(snapshot.path));

  // Present mode: markdown only, rendered slide-by-slide via SlideDeck from
  // the LIVE buffer. Does not require the renderMarkdownPreview callback.
  const shouldShowPresent =
    snapshot !== null && effectiveMode === "present" && isMarkdown(snapshot.path);

  const shouldShowEditor =
    snapshot !== null && !isNonEditable(snapshot) && !shouldShowPreview && !shouldShowPresent;
  const editorPath = shouldShowEditor ? snapshot?.path ?? null : null;

  // Notify parent of view state so it can render its own preview/edit
  // toggle in an external toolbar. We only emit toggle availability for
  // markdown files; non-markdown / no-preview-callback files have no
  // toggle to make. The forced edit modes (conflict, save_blocked) emit
  // `null` so the toolbar doesn't show a useless toggle.
  useEffect(() => {
    if (!onViewStateChange) return;
    const isMd = snapshot !== null && isMarkdown(snapshot.path);
    const canPreview = snapshot !== null && ((renderMarkdownPreview !== undefined && isMd) || isSvg(snapshot.path));
    const isForcedEdit = snapshot?.state === "conflicted" || snapshot?.state === "save_blocked";
    // The toolbar should appear whenever there is a preview/edit toggle OR a
    // Present action (markdown). Forced-edit (conflict) suppresses it.
    if ((!canPreview && !isMd) || isForcedEdit) {
      onViewStateChange(null);
      return;
    }
    onViewStateChange({
      mode: effectiveMode,
      setMode: (mode: ViewMode) => {
        if (mode === "present" && !isMd) return;
        setModeState({ inputPath: path, mode });
      },
      toggle: () => setModeState({
        inputPath: path,
        // From present, the preview/edit toggle returns to preview.
        mode: effectiveMode === "preview" ? "edit" : "preview",
      }),
      canPresent: isMd,
      enterPresent: () => { if (isMd) setModeState({ inputPath: path, mode: "present" }); },
      exitPresent: () => setModeState({ inputPath: path, mode: "preview" }),
      slideIndex: localSlideIndex,
      setSlideIndex: (index: number) => setSlideState({ inputPath: path, index }),
    });
    return () => onViewStateChange(null);
  }, [onViewStateChange, snapshot, effectiveMode, renderMarkdownPreview, path, localSlideIndex]);

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

  // Reveal a requested line once the editor is mounted (opened from a
  // content-search match). Re-runs if the line changes for an already-open file
  // (clicking a different match in the same file) — without recreating Monaco.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (typeof initialRevealLine === "number" && initialRevealLine > 0) {
      const line = Math.max(1, Math.floor(initialRevealLine));
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
  }, [initialRevealLine, editorReadyToken]);

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

  // Export as PDF (print-dialog MVP). Renders preview or all slides into a
  // temporary offscreen DOM, inlines any blob/object images as data URLs,
  // opens a new window with print-friendly CSS and invokes window.print().
  const exportAsPdf = async (): Promise<void> => {
    const snap = snapshot;
    if (!snap) return;
    const content = registry.getModel(snap.path)?.getValue() ?? "";
    const basePathForResolve = dirnameForPath(snap.path);

    // Build an array of slide markdown bodies for present mode, or a single
    // item for preview mode.
    const slides: string[] = effectiveMode === "present" ? splitSlides(content).slides : [content];

    // Create offscreen container where MarkdownView instances will be mounted.
    const tmp = document.createElement("div");
    tmp.style.position = "fixed";
    tmp.style.left = "-9999px";
    tmp.style.top = "-9999px";
    tmp.style.opacity = "0";
    document.body.appendChild(tmp);

    const roots: Array<ReturnType<typeof ReactDOM.createRoot>> = [];
    try {
      const slideHtmls: string[] = [];
      // Render each slide into its own wrapper div.
      for (const s of slides) {
        const wrapper = document.createElement("div");
        tmp.appendChild(wrapper);
        const root = ReactDOM.createRoot(wrapper);
        roots.push(root);
        root.render(
          <div style={{ background: "transparent" }}>
            <MarkdownView basePath={basePathForResolve}>{s}</MarkdownView>
          </div>,
        );
      }

      // Wait briefly for async components (mermaid, images) to settle.
      await new Promise((r) => setTimeout(r, 700));

      // Inline any non-data images by fetching their blobs and converting to data URLs.
      for (const wrapper of Array.from(tmp.children)) {
        const imgs = (wrapper as Element).querySelectorAll("img");
        for (const img of Array.from(imgs)) {
          const src = (img as HTMLImageElement).src;
          if (!src) continue;
          if (src.startsWith("data:")) continue;
          try {
            const resp = await fetch(src);
            const blob = await resp.blob();
            const dataUrl = await new Promise<string>((res) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result as string);
              fr.readAsDataURL(blob);
            });
            (img as HTMLImageElement).src = dataUrl;
          } catch {
            // If inlining fails, leave the original src — print may still fetch it.
          }
        }
        slideHtmls.push((wrapper as HTMLElement).innerHTML);
      }

      // Compose printable HTML: each slide wrapped in a .slide that becomes a page.
      const css = `
        <style>
          @page { size: auto; margin: 12mm; }
          html,body { height: 100%; }
          body { margin: 0; background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
          .slide { page-break-after: always; display: flex; align-items: center; justify-content: center; }
          .slide .content { width: 1100px; max-width: 100%; box-sizing: border-box; padding: 48px 64px; }
          /* Ensure mermaid SVGs scale to fit the content box */
          .slide .content svg { max-width: 100%; height: auto; }
          /* Preserve code block styling */
          pre { background: #1e1e1e; color: #cdd6f4; }
          /* Print exact colors where possible */
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        </style>
      `;

      const bodyHtml = slideHtmls.map((h) => `<div class="slide"><div class="content">${h}</div></div>`).join("");
      const html = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${bodyHtml}</body></html>`;

      const w = window.open("", "_blank");
      if (!w) throw new Error("Failed to open print window");
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      // Wait for the new window to finish layout and load external resources.
      setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 500);
    } finally {
      // Teardown
      for (const r of roots) try { r.unmount(); } catch { /* ignore */ }
      tmp.remove();
    }
  };
  useEffect(() => {
    const canPreview = snapshot !== null && ((renderMarkdownPreview !== undefined && isMarkdown(snapshot.path)) || isSvg(snapshot.path));
    const isForcedEdit = snapshot?.state === "conflicted" || snapshot?.state === "save_blocked";
    if (!canPreview || isForcedEdit) {
      toggleMarkdownModeRef.current = null;
      return;
    }
    toggleMarkdownModeRef.current = () => setModeState({
      inputPath: path,
      mode: effectiveMode === "preview" ? "edit" : "preview",
    });
  }, [snapshot, effectiveMode, renderMarkdownPreview, path]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // In present mode, Escape exits back to preview. Stop propagation so the
    // app's global Esc (which would also exit fullscreen) doesn't double-fire.
    if (event.key === "Escape" && effectiveMode === "present") {
      event.preventDefault();
      event.stopPropagation();
      setModeState({ inputPath: path, mode: "preview" });
      return;
    }
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
            <>
              <button aria-label="Edit" onClick={() => setModeState({ inputPath: path, mode: "edit" })} style={headerButtonStyle}>
                <PencilIcon style={{ width: 16, height: 16 }} />
                <span>Edit</span>
              </button>
              <button aria-label="Export as PDF" onClick={() => { void exportAsPdf(); }} style={headerButtonStyle}>
                <span>Export as PDF</span>
              </button>
            </>
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

    if (shouldShowPresent) {
      const content = registry.getModel(snapshot.path)?.getValue() ?? "";
      return (
        <SlideDeck
          source={content}
          basePath={dirnameForPath(snapshot.path)}
          slideIndex={localSlideIndex}
          onIndexChange={(index) => setSlideState({ inputPath: path, index })}
        />
      );
    }

    if (shouldShowPreview) {
      const content = registry.getModel(snapshot.path)?.getValue() ?? "";
      if (isSvg(snapshot.path)) {
        return (
          <ZoomableImage
            testid="svg-preview"
            src={svgDataUrl(content)}
            alt={fileNameFor(snapshot.path)}
            background="#1e1e2e"
          />
        );
      }
      return <div style={{ height: "100%", overflow: "auto", padding: 16 }}>{renderMarkdownPreview?.(content)}</div>;
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
