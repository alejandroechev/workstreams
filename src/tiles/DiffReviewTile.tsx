// @test-skip: covered by src/tiles/__tests__/DiffReviewTile.test.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as MonacoNs from "monaco-editor";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CheckCircleIcon,
  ChatBubbleLeftRightIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircleIcon,
  ArrowPathIcon,
  PlusCircleIcon,
} from "@heroicons/react/24/outline";
import { useBackend } from "../backend/context";
import { loadMonaco } from "../files/loadMonaco";
import { detectLanguage } from "../domain/tile-config";
import {
  DIFF_REVIEW_EVENTS,
  type ChunkActivePayload,
  type ChunkWithDetails,
  type CompletedPayload,
  type DiffChunk,
  type DiffComment,
  type DiffHunk,
  type DriftDetectedPayload,
  type QuestionStyle,
} from "../domain/diff-review";

interface Props {
  tileId: string;
  isFocused: boolean;
  reviewId: string;
}

interface ModifiedLineRef {
  file: string;
  line: number;
}

interface ParsedHunks {
  originalText: string;
  modifiedText: string;
  modifiedLineRefs: Array<ModifiedLineRef | null>;
}

/**
 * Build the original/modified strings + a line-map for the modified side from
 * a chunk's hunks. The line-map lets us translate Monaco line numbers on the
 * modified side back to real file line numbers (which is what comments are
 * anchored to).
 *
 * Skipped on coverage threshold because it ships from a tile file, but kept
 * pure so it's trivially unit-testable from the tile test.
 */
export function parseHunksForDiffEditor(hunks: DiffHunk[]): ParsedHunks {
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  // Index 0 = "before any line"; lookups use (lineNumber - 1)
  const modifiedLineRefs: Array<ModifiedLineRef | null> = [];

  for (const hunk of hunks) {
    let newOffset = 0;
    const newStart = hunk.new_start ?? 1;
    const oldStart = hunk.old_start ?? 1;

    if (originalLines.length > 0 || modifiedLines.length > 0) {
      originalLines.push("");
      modifiedLines.push("");
      modifiedLineRefs.push(null);
    }
    const header = `// ${hunk.file_path} @@ -${oldStart},${hunk.old_lines ?? 0} +${newStart},${hunk.new_lines ?? 0} @@`;
    originalLines.push(header);
    modifiedLines.push(header);
    modifiedLineRefs.push(null);

    const patchLines = hunk.patch_text.split("\n");
    for (const raw of patchLines) {
      if (raw.startsWith("@@")) continue;
      if (raw.length === 0) continue;
      const marker = raw[0];
      const content = raw.slice(1);
      if (marker === " ") {
        originalLines.push(content);
        modifiedLines.push(content);
        modifiedLineRefs.push({ file: hunk.file_path, line: newStart + newOffset });
        newOffset += 1;
      } else if (marker === "-") {
        originalLines.push(content);
      } else if (marker === "+") {
        modifiedLines.push(content);
        modifiedLineRefs.push({ file: hunk.file_path, line: newStart + newOffset });
        newOffset += 1;
      } else {
        // Treat anything else as context (e.g. lines without a leading marker
        // from sloppy hunks).
        originalLines.push(raw);
        modifiedLines.push(raw);
        modifiedLineRefs.push({ file: hunk.file_path, line: newStart + newOffset });
        newOffset += 1;
      }
    }
  }

  return {
    originalText: originalLines.join("\n"),
    modifiedText: modifiedLines.join("\n"),
    modifiedLineRefs,
  };
}

type MonacoModule = typeof MonacoNs;
type DiffEditor = MonacoNs.editor.IStandaloneDiffEditor;
type TextModel = MonacoNs.editor.ITextModel;

interface Selection {
  file: string;
  startLine: number;
  endLine: number;
}

interface Tallies {
  approved: number;
  commented: number;
  pending: number;
}

function computeTallies(chunks: DiffChunk[]): Tallies {
  const result: Tallies = { approved: 0, commented: 0, pending: 0 };
  for (const c of chunks) {
    if (c.state === "approved") result.approved += 1;
    else if (c.state === "commented") result.commented += 1;
    else result.pending += 1;
  }
  return result;
}

function pickInitialActive(chunks: DiffChunk[]): DiffChunk | null {
  if (chunks.length === 0) return null;
  const unresolved = chunks.find(
    (c) => c.state !== "approved" && c.state !== "commented",
  );
  return unresolved ?? chunks[0];
}

export default function DiffReviewTile({ reviewId }: Props): React.ReactElement {
  const backend = useBackend();
  const [chunks, setChunks] = useState<DiffChunk[]>([]);
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
  const [details, setDetails] = useState<ChunkWithDetails | null>(null);
  const [questionStyle, setQuestionStyle] = useState<QuestionStyle | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [driftChunkIds, setDriftChunkIds] = useState<string[] | null>(null);
  const [completion, setCompletion] = useState<CompletedPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<DiffEditor | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const originalModelRef = useRef<TextModel | null>(null);
  const modifiedModelRef = useRef<TextModel | null>(null);
  const lineRefsRef = useRef<Array<ModifiedLineRef | null>>([]);

  const refreshAll = useCallback(async () => {
    try {
      const list = await backend.listChunks(reviewId);
      setChunks(list);
      const next =
        (activeChunkId && list.find((c) => c.id === activeChunkId)) ||
        pickInitialActive(list);
      if (next) {
        setActiveChunkId(next.id);
        const d = await backend.getChunkDetails(next.id);
        setDetails(d);
        setQuestionStyle(d.chunk.question_style);
      } else {
        setDetails(null);
      }
    } catch (err) {
      setLoadError(String(err));
    }
  }, [backend, reviewId, activeChunkId]);

  useEffect(() => {
    void refreshAll();
    // Only initial-load wiring; chunk-active events trigger refetches below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

  // Event subscriptions: chunk-active / drift-detected / completed
  useEffect(() => {
    const unsubs: Array<Promise<UnlistenFn>> = [];

    unsubs.push(
      listen<ChunkActivePayload>(DIFF_REVIEW_EVENTS.CHUNK_ACTIVE, async (event) => {
        if (event.payload.reviewId !== reviewId) return;
        setActiveChunkId(event.payload.chunkId);
        try {
          const d = await backend.getChunkDetails(event.payload.chunkId);
          setDetails(d);
          setQuestionStyle(d.chunk.question_style);
          const list = await backend.listChunks(reviewId);
          setChunks(list);
        } catch (err) {
          setLoadError(String(err));
        }
      }),
    );

    unsubs.push(
      listen<DriftDetectedPayload>(DIFF_REVIEW_EVENTS.DRIFT_DETECTED, (event) => {
        if (event.payload.reviewId !== reviewId) return;
        setDriftChunkIds(event.payload.chunkIds);
      }),
    );

    unsubs.push(
      listen<CompletedPayload>(DIFF_REVIEW_EVENTS.COMPLETED, (event) => {
        if (event.payload.reviewId !== reviewId) return;
        setCompletion(event.payload);
      }),
    );

    return () => {
      for (const p of unsubs) {
        void p.then((fn) => fn()).catch(() => undefined);
      }
    };
  }, [backend, reviewId]);

  // Monaco wiring — initialize once the diff details land.
  const parsed = useMemo(
    () => (details ? parseHunksForDiffEditor(details.hunks) : null),
    [details],
  );

  const primaryFilePath = useMemo(() => details?.hunks[0]?.file_path ?? "", [details]);
  const editorLanguage = useMemo(
    () => (primaryFilePath ? detectLanguage(primaryFilePath) : "plaintext"),
    [primaryFilePath],
  );

  useEffect(() => {
    lineRefsRef.current = parsed?.modifiedLineRefs ?? [];
  }, [parsed]);

  useEffect(() => {
    let disposed = false;

    const ensureEditor = async () => {
      if (!parsed) return;
      const monaco = monacoRef.current ?? (await loadMonaco());
      if (disposed) return;
      monacoRef.current = monaco;
      if (!containerRef.current) return;

      if (!editorRef.current) {
        const original = monaco.editor.createModel(parsed.originalText, editorLanguage);
        const modified = monaco.editor.createModel(parsed.modifiedText, editorLanguage);
        originalModelRef.current = original;
        modifiedModelRef.current = modified;
        const editor = monaco.editor.createDiffEditor(containerRef.current, {
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          renderSideBySide: false,
          theme: "vs-dark",
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'Cascadia Code', 'Consolas', monospace",
          scrollBeyondLastLine: false,
          overviewRulerBorder: false,
        });
        editor.setModel({ original, modified });
        editorRef.current = editor;
        const modifiedEditor = editor.getModifiedEditor?.();
        modifiedEditor?.onDidChangeCursorSelection?.((e) => {
          const startLine = e.selection.startLineNumber;
          const endLine = e.selection.endLineNumber;
          const startRef = lineRefsRef.current[startLine - 1];
          const endRef = lineRefsRef.current[endLine - 1] ?? startRef;
          if (!startRef) return;
          setSelection({
            file: startRef.file,
            startLine: startRef.line,
            endLine: endRef ? endRef.line : startRef.line,
          });
        });
      } else {
        originalModelRef.current?.setValue(parsed.originalText);
        modifiedModelRef.current?.setValue(parsed.modifiedText);
        if (originalModelRef.current) {
          monaco.editor.setModelLanguage(originalModelRef.current, editorLanguage);
        }
        if (modifiedModelRef.current) {
          monaco.editor.setModelLanguage(modifiedModelRef.current, editorLanguage);
        }
      }
    };

    void ensureEditor();
    return () => {
      disposed = true;
    };
  }, [parsed, editorLanguage]);

  useEffect(
    () => () => {
      editorRef.current?.dispose();
      originalModelRef.current?.dispose();
      modifiedModelRef.current?.dispose();
      editorRef.current = null;
      originalModelRef.current = null;
      modifiedModelRef.current = null;
    },
    [],
  );

  const tallies = useMemo(() => computeTallies(chunks), [chunks]);
  const activeOrdinal = useMemo(() => {
    const idx = chunks.findIndex((c) => c.id === activeChunkId);
    return idx >= 0 ? idx + 1 : 0;
  }, [chunks, activeChunkId]);

  const defaultAnchor = useMemo<Selection | null>(() => {
    if (selection) return selection;
    if (!details || details.hunks.length === 0) return null;
    const h = details.hunks[0];
    const start = h.new_start ?? 1;
    const end = start + Math.max((h.new_lines ?? 1) - 1, 0);
    return { file: h.file_path, startLine: start, endLine: end };
  }, [selection, details]);

  const onAddComment = useCallback(async () => {
    if (!activeChunkId || !defaultAnchor || commentDraft.trim().length === 0) return;
    try {
      await backend.addComment(
        activeChunkId,
        defaultAnchor.file,
        defaultAnchor.startLine,
        defaultAnchor.endLine,
        commentDraft.trim(),
      );
      setCommentDraft("");
      await refreshAll();
    } catch (err) {
      setLoadError(String(err));
    }
  }, [activeChunkId, defaultAnchor, commentDraft, backend, refreshAll]);

  const onApprove = useCallback(async () => {
    if (!activeChunkId) return;
    try {
      await backend.ackChunk(activeChunkId, "approved");
      await refreshAll();
    } catch (err) {
      setLoadError(String(err));
    }
  }, [activeChunkId, backend, refreshAll]);

  const onCommentedDone = useCallback(async () => {
    if (!activeChunkId) return;
    try {
      await backend.ackChunk(activeChunkId, "commented");
      await refreshAll();
    } catch (err) {
      setLoadError(String(err));
    }
  }, [activeChunkId, backend, refreshAll]);

  const onReFetchAfterDrift = useCallback(async () => {
    setDriftChunkIds(null);
    await refreshAll();
  }, [refreshAll]);

  const totalChunks = chunks.length;
  const completedChunks = tallies.approved + tallies.commented;
  const progress = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;

  return (
    <div
      data-testid="diff-review-tile"
      style={{ display: "flex", flexDirection: "column", height: "100%", color: "#cdd6f4", background: "#1e1e2e" }}
    >
      {/* Header */}
      <div
        data-testid="diff-review-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 10px",
          borderBottom: "1px solid #313244",
          background: "#181825",
          minHeight: 32,
        }}
      >
        <div
          aria-label="Review progress"
          data-testid="diff-review-progress"
          style={{ flex: 1, height: 6, background: "#313244", borderRadius: 3, overflow: "hidden" }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              background: "#a6e3a1",
              transition: "width 0.2s",
            }}
          />
        </div>
        <span style={{ fontSize: 12, color: "#cdd6f4" }} data-testid="diff-review-counter">
          chunk {activeOrdinal}/{totalChunks}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }} data-testid="diff-review-tallies">
          <span style={{ display: "flex", alignItems: "center", gap: 2, color: "#a6e3a1" }}>
            <CheckCircleIcon style={{ width: 12, height: 12 }} />
            {tallies.approved}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 2, color: "#89b4fa" }}>
            <ChatBubbleLeftRightIcon style={{ width: 12, height: 12 }} />
            {tallies.commented}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 2, color: "#f9e2af" }}>
            <QuestionMarkCircleIcon style={{ width: 12, height: 12 }} />
            {tallies.pending}
          </span>
        </span>
      </div>

      {driftChunkIds && driftChunkIds.length > 0 && (
        <div
          data-testid="diff-review-drift-banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            background: "#3a1f1f",
            color: "#f38ba8",
            borderBottom: "1px solid #45475a",
            fontSize: 12,
          }}
        >
          <ExclamationTriangleIcon style={{ width: 14, height: 14 }} />
          Drift detected in {driftChunkIds.length} chunk(s). Re-fetch to continue.
          <button
            data-testid="diff-review-drift-refetch"
            onClick={() => void onReFetchAfterDrift()}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "1px solid #f38ba8",
              color: "#f38ba8",
              borderRadius: 3,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <ArrowPathIcon style={{ width: 12, height: 12 }} />
            Re-fetch
          </button>
        </div>
      )}

      {loadError && (
        <div
          data-testid="diff-review-error"
          style={{ padding: "6px 10px", background: "#3a1f1f", color: "#f38ba8", fontSize: 12 }}
        >
          {loadError}
        </div>
      )}

      {/* Main panes */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div
          data-testid="diff-review-diff-pane"
          style={{ flex: "0 0 65%", borderRight: "1px solid #313244", display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          {details ? (
            <>
              <div
                style={{
                  padding: "6px 10px",
                  borderBottom: "1px solid #313244",
                  fontSize: 12,
                  color: "#a6adc8",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <strong style={{ color: "#cdd6f4" }} data-testid="diff-review-chunk-title">
                  {details.chunk.title}
                </strong>
                <span style={{ opacity: 0.7 }}>{details.chunk.summary ?? ""}</span>
              </div>
              <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} data-testid="diff-review-monaco" />
            </>
          ) : (
            <div style={{ padding: 12, opacity: 0.6 }}>No active chunk.</div>
          )}
        </div>

        <div
          data-testid="diff-review-side-pane"
          style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          {/* Question */}
          <div
            data-testid="diff-review-question"
            style={{
              flex: "0 0 30%",
              padding: 12,
              borderBottom: "1px solid #313244",
              overflow: "auto",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", color: "#a6adc8", marginBottom: 4 }}>
              Question
              {questionStyle && (
                <span style={{ marginLeft: 6, color: "#89b4fa" }} data-testid="diff-review-question-style">
                  ({questionStyle})
                </span>
              )}
            </div>
            <div style={{ fontSize: 13, color: "#cdd6f4", whiteSpace: "pre-wrap" }}>
              {details?.chunk.question_text ?? "Waiting for the skill to post a question..."}
            </div>
          </div>

          {/* Comments + actions */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ padding: "8px 12px 4px", fontSize: 11, textTransform: "uppercase", color: "#a6adc8" }}>
              Comments ({details?.comments.length ?? 0})
            </div>
            <div
              data-testid="diff-review-comments-list"
              style={{ flex: 1, overflow: "auto", padding: "0 12px" }}
            >
              {(details?.comments ?? []).length === 0 ? (
                <div style={{ opacity: 0.6, fontSize: 12 }}>No comments yet.</div>
              ) : (
                (details?.comments ?? []).map((c: DiffComment) => (
                  <div
                    key={c.id}
                    data-testid={`diff-review-comment-${c.id}`}
                    style={{
                      borderLeft: "2px solid #89b4fa",
                      padding: "4px 8px",
                      margin: "6px 0",
                      background: "#181825",
                      borderRadius: 3,
                    }}
                  >
                    <div style={{ fontSize: 10, color: "#a6adc8" }}>
                      {c.anchor_file} L{c.anchor_line_start}-{c.anchor_line_end}
                    </div>
                    <div style={{ fontSize: 12, color: "#cdd6f4", whiteSpace: "pre-wrap" }}>{c.text}</div>
                  </div>
                ))
              )}
            </div>

            <div style={{ borderTop: "1px solid #313244", padding: 10 }}>
              <div style={{ fontSize: 11, color: "#a6adc8" }} data-testid="diff-review-anchor">
                Anchor: {defaultAnchor ? `${defaultAnchor.file} L${defaultAnchor.startLine}-${defaultAnchor.endLine}` : "(no selection)"}
              </div>
              <textarea
                data-testid="diff-review-comment-input"
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Add a comment..."
                style={{
                  width: "100%",
                  marginTop: 4,
                  background: "#11111b",
                  color: "#cdd6f4",
                  border: "1px solid #45475a",
                  borderRadius: 3,
                  padding: 6,
                  fontSize: 12,
                  resize: "vertical",
                  minHeight: 48,
                }}
              />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  data-testid="diff-review-add-comment"
                  onClick={() => void onAddComment()}
                  disabled={!defaultAnchor || commentDraft.trim().length === 0}
                  style={primaryButton(!defaultAnchor || commentDraft.trim().length === 0)}
                >
                  <PlusCircleIcon style={{ width: 12, height: 12 }} />
                  Add comment
                </button>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <button
                  data-testid="diff-review-approve"
                  onClick={() => void onApprove()}
                  disabled={!activeChunkId}
                  style={approveButton(!activeChunkId)}
                >
                  <CheckCircleIcon style={{ width: 12, height: 12 }} />
                  Approve
                </button>
                <button
                  data-testid="diff-review-commented-done"
                  onClick={() => void onCommentedDone()}
                  disabled={!activeChunkId}
                  style={commentedButton(!activeChunkId)}
                >
                  <ChatBubbleLeftRightIcon style={{ width: 12, height: 12 }} />
                  Done with comments
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {completion && (
        <div
          data-testid="diff-review-completed-overlay"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(17, 17, 27, 0.92)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#cdd6f4",
            zIndex: 10,
          }}
        >
          <div style={{ textAlign: "center" }}>
            <CheckCircleIcon style={{ width: 32, height: 32, color: "#a6e3a1" }} />
            <div style={{ marginTop: 8, fontSize: 16 }}>Review complete</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "#a6adc8" }}>
              Exported to {completion.exportedPath}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#313244" : "#89b4fa",
    color: disabled ? "#6c7086" : "#11111b",
    border: "none",
    borderRadius: 3,
    padding: "4px 8px",
    fontSize: 11,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    gap: 4,
  };
}

function approveButton(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#313244" : "#a6e3a1",
    color: disabled ? "#6c7086" : "#11111b",
    border: "none",
    borderRadius: 3,
    padding: "5px 10px",
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontWeight: 600,
  };
}

function commentedButton(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#313244" : "#89b4fa",
    color: disabled ? "#6c7086" : "#11111b",
    border: "none",
    borderRadius: 3,
    padding: "5px 10px",
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontWeight: 600,
  };
}
