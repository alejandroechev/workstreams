// @test-skip: covered by src/tiles/__tests__/CodeReviewTile.test.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as MonacoNs from "monaco-editor";
import { DiffEditor } from "@monaco-editor/react";
import {
  CheckCircleIcon,
  ArrowUturnLeftIcon,
  ExclamationTriangleIcon,
  PlusCircleIcon,
  DocumentIcon,
} from "@heroicons/react/24/outline";
import { useBackend } from "../backend/context";
import { detectLanguage } from "../domain/tile-config";
import { MarkdownView } from "../ui/MarkdownView";
import type { Review, ReviewComment, ChangedFile, DiffSource } from "../domain/code-review";
import {
  groupThreads,
  threadsByLine,
  isOpenThread,
  attentionCount,
  openCount,
  statusLabel,
  basename,
  fileStatusLabel,
  type CommentThread,
} from "../domain/code-review-view";

interface Props {
  tileId: string;
  isFocused: boolean;
  workstreamId: string;
  workstreamDir?: string;
}

const POLL_MS = 1500;

/**
 * Code Review tile (ADR 014) — local PR-style review. Pick a diff source, see
 * the real diff, comment inline on the modified side, hand comments to the
 * agent (it reads/replies via its own `sql` tool on the session DB), and see
 * replies via polling. In-place editing of the modified side is added by the
 * `inplace-edit` phase.
 */
export default function CodeReviewTile({ workstreamId, workstreamDir, isFocused }: Props) {
  const backend = useBackend();
  const dir = workstreamDir ?? "";

  const [sessionResolved, setSessionResolved] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sides, setSides] = useState<{ before: string; after: string }>({ before: "", after: "" });
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-review picker state.
  const [picking, setPicking] = useState(false);
  const [draftSource, setDraftSource] = useState<DiffSource>("working_tree");
  const [draftBase, setDraftBase] = useState("master");

  // Comment composer (anchored to a selected new-side line).
  const [pendingAnchor, setPendingAnchor] = useState<{ file: string; line: number; code: string } | null>(null);
  const [composerBody, setComposerBody] = useState("");

  const modifiedEditorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const zoneIdsRef = useRef<string[]>([]);

  const reviewRef = useRef<Review | null>(null);
  reviewRef.current = review;
  const selectedFileRef = useRef<string | null>(null);
  selectedFileRef.current = selectedFile;

  // ── Resolve the bound session + active review on mount ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await backend.resolveWorkstreamSession(workstreamId);
        if (cancelled) return;
        setHasSession(!!session);
        setSessionResolved(true);
        if (!session) return;
        const active = await backend.getActiveReview(workstreamId);
        if (cancelled) return;
        if (active) setReview(active);
        else setPicking(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workstreamId]);

  const loadFiles = useCallback(
    async (r: Review) => {
      try {
        const f = await backend.codeReviewDiffFiles(dir, r.diff_source, r.base_ref);
        setFiles(f);
        if (f.length > 0) setSelectedFile((cur) => cur ?? f[0].path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [backend, dir],
  );

  const loadComments = useCallback(async () => {
    const r = reviewRef.current;
    if (!r) return;
    try {
      const list = await backend.listReviewComments(workstreamId, r.id);
      setComments(list);
    } catch {
      /* keep last good on transient poll errors */
    }
  }, [backend, workstreamId]);

  // Load files + comments when the review changes.
  useEffect(() => {
    if (!review) return;
    void loadFiles(review);
    void loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.id]);

  // Load the selected file's diff sides.
  useEffect(() => {
    if (!review || !selectedFile) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await backend.codeReviewDiffFileSides(dir, selectedFile, review.diff_source, review.base_ref);
        if (!cancelled) setSides(s);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile, review?.id]);

  // Poll comments for the agent's writes while focused.
  useEffect(() => {
    if (!review || !isFocused) return;
    const t = setInterval(() => void loadComments(), POLL_MS);
    return () => clearInterval(t);
  }, [review, isFocused, loadComments]);

  const threads: CommentThread[] = useMemo(() => groupThreads(comments), [comments]);
  const attention = attentionCount(threads);
  const stillOpen = openCount(threads);
  const completable = review?.status === "open" && threads.length > 0 && stillOpen === 0;

  // ── Inline view zones: render a marker under each commented new-side line ──
  useEffect(() => {
    const editor = modifiedEditorRef.current;
    if (!editor || !selectedFile) return;
    const byLine = threadsByLine(threads, selectedFile);
    editor.changeViewZones((accessor) => {
      for (const id of zoneIdsRef.current) accessor.removeZone(id);
      zoneIdsRef.current = [];
      for (const [line, ts] of byLine) {
        const dom = document.createElement("div");
        dom.className = "cr-zone";
        dom.style.cssText = "background:#181825;border-left:3px solid #89b4fa;padding:4px 10px;color:#cdd6f4;font-size:12px;font-family:monospace";
        const t0 = ts[0];
        dom.textContent = `💬 ${t0.root.author}: ${t0.root.body}${ts.length > 1 || t0.replies.length ? "  (thread)" : ""}`;
        accessor.addZone({ afterLineNumber: line, heightInLines: 1, domNode: dom });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, selectedFile, sides]);

  const onDiffMount = useCallback((editor: MonacoNs.editor.IStandaloneDiffEditor) => {
    const modified = editor.getModifiedEditor();
    modifiedEditorRef.current = modified;
    modified.onDidChangeCursorSelection((e) => {
      const line = e.selection.positionLineNumber;
      const file = selectedFileRef.current;
      if (!file) return;
      const code = modified.getModel()?.getLineContent(line) ?? "";
      setPendingAnchor({ file, line, code });
    });
  }, []);

  const createReview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await backend.createReview(
        workstreamId,
        draftSource,
        draftSource === "branch" ? draftBase.trim() || "master" : null,
      );
      setPicking(false);
      setSelectedFile(null);
      setReview(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [backend, workstreamId, draftSource, draftBase]);

  const addComment = useCallback(async () => {
    const r = reviewRef.current;
    const anchor = pendingAnchor;
    if (!r || !anchor || !composerBody.trim()) return;
    setBusy(true);
    try {
      await backend.addReviewComment(
        workstreamId,
        r.id,
        anchor.file,
        anchor.line,
        "new",
        anchor.code || null,
        null,
        composerBody.trim(),
      );
      setComposerBody("");
      setPendingAnchor(null);
      await loadComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [backend, workstreamId, pendingAnchor, composerBody, loadComments]);

  const setStatus = useCallback(
    async (commentId: string, status: string) => {
      setBusy(true);
      try {
        await backend.setReviewCommentStatus(workstreamId, commentId, status);
        await loadComments();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [backend, workstreamId, loadComments],
  );

  const complete = useCallback(async () => {
    const r = reviewRef.current;
    if (!r) return;
    setBusy(true);
    try {
      await backend.completeCodeReview(workstreamId, r.id);
      setReview({ ...r, status: "completed" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [backend, workstreamId]);

  // ── Render ──
  if (!sessionResolved) {
    return <div data-testid="code-review-tile" style={styles.center}>Loading…</div>;
  }
  if (!hasSession) {
    return (
      <div data-testid="code-review-tile" style={styles.center}>
        <div style={{ textAlign: "center", color: "#a6adc8", fontSize: 13 }}>
          Open a Copilot session in this workstream to start a code review.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="code-review-tile" style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Code Review</span>
        {review && (
          <span style={styles.badge2} data-testid="review-source">
            {review.diff_source}{review.base_ref ? ` vs ${review.base_ref}` : ""}
          </span>
        )}
        {stillOpen > 0 && <span style={styles.chip} data-testid="open-count">{stillOpen} open</span>}
        {attention > 0 && (
          <span style={styles.attention} data-testid="attention-badge">
            <ExclamationTriangleIcon width={12} height={12} /> {attention}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button style={styles.btn} disabled={busy} onClick={() => setPicking(true)} data-testid="new-review">
          <PlusCircleIcon width={14} height={14} /> New review
        </button>
        {completable && (
          <button style={styles.btnPrimary} disabled={busy} onClick={complete} data-testid="complete-review">
            <CheckCircleIcon width={14} height={14} /> Complete
          </button>
        )}
        {review?.status === "completed" && <span style={styles.done} data-testid="review-completed">Completed</span>}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {picking && (
        <div style={styles.picker} data-testid="review-picker">
          <select
            data-testid="diff-source-select"
            value={draftSource}
            onChange={(e) => setDraftSource(e.target.value as DiffSource)}
            style={styles.input}
          >
            <option value="working_tree">Working tree (uncommitted)</option>
            <option value="last_commit">Last commit</option>
            <option value="branch">Branch vs base</option>
          </select>
          {draftSource === "branch" && (
            <input
              data-testid="base-ref-input"
              style={styles.input}
              value={draftBase}
              onChange={(e) => setDraftBase(e.target.value)}
              placeholder="base ref (e.g. master)"
            />
          )}
          <button style={styles.btnPrimary} disabled={busy} onClick={createReview} data-testid="create-review">
            Start review
          </button>
        </div>
      )}

      {review && (
        <div style={styles.body}>
          {/* File list */}
          <div style={styles.fileList} data-testid="file-list">
            {files.length === 0 && <div style={styles.muted}>No changes in this diff source.</div>}
            {files.map((f) => (
              <button
                key={f.path}
                data-testid={`file-${f.path}`}
                onClick={() => setSelectedFile(f.path)}
                style={{ ...styles.fileRow, background: selectedFile === f.path ? "#313244" : "transparent" }}
              >
                <DocumentIcon width={12} height={12} style={{ flexShrink: 0, color: "#89b4fa" }} />
                <span style={styles.fileName}>{basename(f.path)}</span>
                <span style={styles.fileStatus}>{fileStatusLabel(f.status)}</span>
              </button>
            ))}
          </div>

          {/* Diff + composer */}
          <div style={styles.diffPane}>
            {selectedFile ? (
              <>
                <div style={styles.diffToolbar}>
                  <span style={styles.filePathText}>{selectedFile}</span>
                  {pendingAnchor && (
                    <span style={styles.muted} data-testid="pending-anchor">line {pendingAnchor.line}</span>
                  )}
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <DiffEditor
                    key={selectedFile}
                    height="100%"
                    language={detectLanguage(selectedFile)}
                    original={sides.before}
                    modified={sides.after}
                    theme="vs-dark"
                    onMount={onDiffMount}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      overviewRulerBorder: false,
                    }}
                  />
                </div>
                {pendingAnchor && (
                  <div style={styles.composer} data-testid="comment-composer">
                    <textarea
                      data-testid="comment-body"
                      style={styles.textarea}
                      placeholder={`Comment on ${basename(pendingAnchor.file)}:${pendingAnchor.line} (markdown)`}
                      value={composerBody}
                      onChange={(e) => setComposerBody(e.target.value)}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={styles.btnPrimary} disabled={busy} onClick={addComment} data-testid="add-comment">
                        Comment
                      </button>
                      <button style={styles.btn} disabled={busy} onClick={() => { setPendingAnchor(null); setComposerBody(""); }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={styles.center}>Pick a file to review.</div>
            )}
          </div>

          {/* Comments panel */}
          <div style={styles.commentsPanel} data-testid="comments-panel">
            {threads.length === 0 && <div style={styles.muted}>No comments yet — select a line in the diff.</div>}
            {threads.map((t) => {
              const open = isOpenThread(t.root);
              return (
                <div key={t.root.id} style={styles.thread} data-testid="comment-thread">
                  <div style={styles.threadHead}>
                    <button
                      style={styles.anchorBtn}
                      onClick={() => setSelectedFile(t.root.file)}
                      title="jump to file"
                    >
                      {basename(t.root.file)}:{t.root.line}
                    </button>
                    <span style={{ ...styles.statusChip, ...(open ? {} : styles.statusChipClosed) }} data-testid="thread-status">
                      {statusLabel(t.root.status)}
                    </span>
                  </div>
                  {t.root.code && <pre style={styles.code}>{t.root.code}</pre>}
                  <div style={styles.commentBody}><MarkdownView>{t.root.body}</MarkdownView></div>
                  {t.replies.map((rep) => (
                    <div key={rep.id} style={styles.reply} data-testid="thread-reply">
                      <span style={styles.author}>{rep.author}</span>
                      <div style={styles.commentBody}><MarkdownView>{rep.body}</MarkdownView></div>
                    </div>
                  ))}
                  <div style={{ marginTop: 6 }}>
                    {open ? (
                      <button style={styles.btn} disabled={busy} onClick={() => setStatus(t.root.id, "resolved")} data-testid="resolve">
                        <CheckCircleIcon width={13} height={13} /> Resolve
                      </button>
                    ) : (
                      <button style={styles.btn} disabled={busy} onClick={() => setStatus(t.root.id, "open")} data-testid="reopen">
                        <ArrowUturnLeftIcon width={13} height={13} /> Reopen
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", background: "#1e1e2e", color: "#cdd6f4", fontSize: 13 },
  center: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#6c7086" },
  header: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid #313244" },
  title: { fontWeight: 600 },
  badge2: { color: "#a6adc8", fontSize: 11, background: "#181825", borderRadius: 6, padding: "1px 6px" },
  chip: { background: "#313244", color: "#cdd6f4", borderRadius: 8, padding: "1px 6px", fontSize: 11 },
  attention: { display: "inline-flex", alignItems: "center", gap: 3, background: "#f9e2af", color: "#1e1e2e", borderRadius: 8, padding: "1px 6px", fontSize: 11, fontWeight: 600 },
  btn: { display: "inline-flex", alignItems: "center", gap: 4, background: "#313244", color: "#cdd6f4", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 12 },
  btnPrimary: { display: "inline-flex", alignItems: "center", gap: 4, background: "#89b4fa", color: "#1e1e2e", border: "none", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontWeight: 600, fontSize: 12 },
  done: { color: "#a6e3a1", fontSize: 12, fontWeight: 600 },
  error: { color: "#f38ba8", padding: "6px 10px", fontSize: 12 },
  picker: { display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid #313244" },
  input: { background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 6, padding: "4px 8px", fontSize: 12 },
  body: { flex: 1, display: "flex", minHeight: 0 },
  fileList: { width: 180, borderRight: "1px solid #313244", overflowY: "auto", flexShrink: 0 },
  fileRow: { display: "flex", alignItems: "center", gap: 6, width: "100%", border: "none", color: "#cdd6f4", cursor: "pointer", padding: "5px 8px", textAlign: "left", fontSize: 12 },
  fileName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  fileStatus: { color: "#6c7086", fontSize: 10 },
  diffPane: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
  diffToolbar: { display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", borderBottom: "1px solid #313244" },
  filePathText: { flex: 1, fontFamily: "monospace", fontSize: 11, color: "#89dceb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  composer: { borderTop: "1px solid #313244", padding: 8, display: "flex", flexDirection: "column", gap: 6 },
  textarea: { minHeight: 48, background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 6, padding: 6, fontFamily: "inherit", fontSize: 12 },
  commentsPanel: { width: 300, borderLeft: "1px solid #313244", overflowY: "auto", flexShrink: 0, padding: 8, display: "flex", flexDirection: "column", gap: 8 },
  muted: { color: "#6c7086", fontSize: 12, padding: 8, fontStyle: "italic" },
  thread: { border: "1px solid #313244", borderRadius: 8, padding: 8 },
  threadHead: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  anchorBtn: { background: "none", border: "none", color: "#89dceb", cursor: "pointer", fontFamily: "monospace", fontSize: 12, padding: 0 },
  statusChip: { background: "#313244", color: "#cdd6f4", borderRadius: 6, padding: "1px 6px", fontSize: 10 },
  statusChipClosed: { background: "#a6e3a1", color: "#1e1e2e" },
  code: { background: "#181825", borderRadius: 6, padding: 6, overflowX: "auto", fontSize: 11, margin: "4px 0" },
  commentBody: { fontSize: 13 },
  reply: { borderLeft: "2px solid #45475a", paddingLeft: 8, margin: "6px 0" },
  author: { color: "#f9e2af", fontSize: 11, fontWeight: 600 },
};
