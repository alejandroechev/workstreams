// @test-skip: covered by src/tiles/__tests__/CodeReviewTile.test.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as MonacoNs from "monaco-editor";
import { DiffEditor } from "@monaco-editor/react";
import { ensureLocalMonacoLoader } from "../files/monacoLoaderConfig";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  PlusCircleIcon,
  DocumentIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import { useBackend } from "../backend/context";
import { detectLanguage } from "../domain/tile-config";
import { fileBufferRegistry } from "../files/FileBufferRegistry";
import { GITHUB_DARK_DIFF_THEME, defineGithubDiffTheme } from "../ui/monaco-diff-theme";
import { INTERACTIVE_ZONES_CLASS, markInteractiveZoneNode } from "../ui/interactive-zones";
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
  modifiedEditable,
  type CommentThread,
} from "../domain/code-review-view";

interface Props {
  tileId: string;
  isFocused: boolean;
  workstreamId: string;
  workstreamDir?: string;
}


/**
 * Code Review tile (ADR 014) — local PR-style review. Pick a diff source, see
 * the real diff, comment inline on the modified side, hand comments to the
 * agent (it reads/replies via its own `sql` tool on the session DB), and see
 * replies via polling. In-place editing of the modified side is added by the
 * `inplace-edit` phase.
 */
export default function CodeReviewTile({ workstreamId, workstreamDir, isFocused: _isFocused }: Props) {
  const backend = useBackend();
  const dir = workstreamDir ?? "";

  const [sessionResolved, setSessionResolved] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  // `@monaco-editor/react` fetches Monaco from a CDN unless told otherwise, so
  // the diff silently never mounts without network. Point it at the bundled
  // copy before rendering, and hold the editor back until that has happened —
  // configuring after the first mount is too late to help.
  const [monacoReady, setMonacoReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void ensureLocalMonacoLoader().then(() => {
      if (!cancelled) setMonacoReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Comment composer. `selectionAnchor` is the current non-empty new-side line
  // range (drives the floating "+ Comment" button); `composer` is the open
  // inline composer for a chosen range. Mirrors the Repo Explorer file-comment
  // UX (floating button on selection → inline composer → view-zone threads).
  const [selectionAnchor, setSelectionAnchor] = useState<{ start: number; end: number } | null>(null);
  const [composer, setComposer] = useState<{ start: number; end: number; body: string } | null>(null);

  // In-place editing (ADR 014 §4) — only when the modified side is the working file.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const editable = review ? modifiedEditable(review.diff_source) : false;
  const editableRef = useRef(false);
  editableRef.current = editable;
  const sidesAfterRef = useRef("");
  sidesAfterRef.current = sides.after;

  const modifiedEditorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const zoneIdsRef = useRef<string[]>([]);
  // Bumped once when the diff editor first mounts so the view-zone effect
  // re-runs after the editor ref is available. Without this the effect can run
  // while the editor is still null and never render the comment zones. (The
  // now-removed 1.5s poll previously masked this by forcing re-renders.) The
  // bump is guarded + deferred so it never fires during the DiffEditor's render
  // (which would loop): file switches are already covered by the effect deps.
  const [editorReadyToken, setEditorReadyToken] = useState(0);
  const editorReadyBumpedRef = useRef(false);
  // Latest setStatus, held in a ref so imperative view-zone buttons call fresh.
  const setStatusRef = useRef<(id: string, status: string) => void>(() => {});
  const busyRef = useRef(false);
  busyRef.current = busy;

  /** Estimated view-zone height (in editor line units) for a line's threads. */
  function estimateThreadZoneLines(ts: CommentThread[]): number {
    let lines = 1; // top padding
    for (const t of ts) {
      lines += 1; // meta header
      if (t.root.code) lines += 1;
      lines += Math.max(1, Math.ceil(t.root.body.length / 70));
      for (const rep of t.replies) lines += 1 + Math.max(1, Math.ceil(rep.body.length / 70));
      lines += 1; // action row
    }
    return lines + 1; // bottom padding
  }

  /** Imperatively render a comment thread (reviewer + agent replies + resolve). */
  function renderThreadZone(node: HTMLDivElement, ts: CommentThread[], reviewOpen: boolean): void {
    node.innerHTML = "";
    markInteractiveZoneNode(node);
    node.style.cssText +=
      ";background:#181825;border-left:3px solid #89b4fa;padding:6px 10px;color:#cdd6f4;font-size:12px;font-family:'Cascadia Code','Consolas',monospace;overflow:auto";
    for (const t of ts) {
      const open = isOpenThread(t.root);
      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:2px";
      const author = document.createElement("span");
      author.textContent = t.root.author;
      author.style.cssText = "color:#f9e2af;font-weight:600";
      head.appendChild(author);
      const status = document.createElement("span");
      status.dataset.testid = "thread-status";
      status.textContent = statusLabel(t.root.status);
      status.style.cssText = open
        ? "background:#313244;color:#cdd6f4;border-radius:6px;padding:0 6px;font-size:10px"
        : "background:#a6e3a1;color:#1e1e2e;border-radius:6px;padding:0 6px;font-size:10px";
      head.appendChild(status);
      node.appendChild(head);

      if (t.root.code) {
        const code = document.createElement("pre");
        code.textContent = t.root.code;
        code.style.cssText = "background:#11111b;border-radius:4px;padding:4px 6px;margin:2px 0;font-size:11px;overflow-x:auto";
        node.appendChild(code);
      }
      const body = document.createElement("div");
      body.textContent = t.root.body;
      body.style.cssText = "white-space:pre-wrap;word-break:break-word;line-height:1.5";
      node.appendChild(body);

      for (const rep of t.replies) {
        const wrap = document.createElement("div");
        wrap.dataset.testid = "thread-reply";
        wrap.style.cssText = "border-left:2px solid #45475a;padding-left:8px;margin:4px 0";
        const ra = document.createElement("span");
        ra.textContent = rep.author;
        ra.style.cssText = "color:#f9e2af;font-size:11px;font-weight:600";
        wrap.appendChild(ra);
        const rb = document.createElement("div");
        rb.textContent = rep.body;
        rb.style.cssText = "white-space:pre-wrap;word-break:break-word;line-height:1.5";
        wrap.appendChild(rb);
        node.appendChild(wrap);
      }

      if (reviewOpen) {
        const btn = document.createElement("button");
        btn.dataset.testid = open ? "resolve" : "reopen";
        btn.textContent = open ? "Resolve" : "Reopen";
        btn.style.cssText =
          "margin-top:4px;background:none;border:1px solid #45475a;color:#89b4fa;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;pointer-events:auto";
        btn.addEventListener("mousedown", (e) => e.stopPropagation());
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (busyRef.current) return;
          setStatusRef.current(t.root.id, open ? "resolved" : "open");
        });
        node.appendChild(btn);
      }
    }
  }

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
    setDirty(false);
    setSelectionAnchor(null);
    setComposer(null);
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

  // Manual Sync (no polling): re-read reviews/review_comments from session.db
  // on demand via the header Sync button. unify-commenting removed the ~1.5s
  // poll to avoid steady background churn on the session DB.
  const [syncing, setSyncing] = useState(false);
  const syncComments = useCallback(async () => {
    setSyncing(true);
    try {
      await loadComments();
    } finally {
      setSyncing(false);
    }
  }, [loadComments]);

  const threads: CommentThread[] = useMemo(() => groupThreads(comments), [comments]);
  const attention = attentionCount(threads);
  const stillOpen = openCount(threads);
  const completable = review?.status === "open" && threads.length > 0 && stillOpen === 0;

  // ── Inline view zones: render the full comment thread under each commented
  // new-side line, with an inline Resolve/Reopen action (Repo-Explorer-style). ──
  useEffect(() => {
    const editor = modifiedEditorRef.current;
    if (!editor || !selectedFile) return;
    const byLine = threadsByLine(threads, selectedFile);
    const reviewOpen = reviewRef.current?.status === "open";
    editor.changeViewZones((accessor) => {
      for (const id of zoneIdsRef.current) accessor.removeZone(id);
      zoneIdsRef.current = [];
      for (const [line, ts] of byLine) {
        const dom = document.createElement("div");
        renderThreadZone(dom, ts, reviewOpen);
        const id = accessor.addZone({
          afterLineNumber: line,
          heightInLines: estimateThreadZoneLines(ts),
          domNode: dom,
        });
        zoneIdsRef.current.push(id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, selectedFile, sides, editorReadyToken]);

  const absPath = useCallback(
    (file: string) => `${dir.replace(/[\\/]+$/, "")}/${file}`,
    [dir],
  );

  const saveEdit = useCallback(async () => {
    const editor = modifiedEditorRef.current;
    const file = selectedFileRef.current;
    if (!editor || !file || !editableRef.current) return;
    const content = editor.getModel()?.getValue() ?? "";
    setSaving(true);
    try {
      // Persist through the shared FileBufferRegistry so the write uses the
      // same EOL/conflict handling as any file save (ADR 014 §4).
      const snap = await fileBufferRegistry.acquire(absPath(file));
      fileBufferRegistry.getModel(snap.path)?.setValue(content);
      await fileBufferRegistry.save(snap.path);
      setDirty(false);
      // Re-diff: the edit may change the diff (e.g. removing an added line).
      const r = reviewRef.current;
      if (r) {
        const s = await backend.codeReviewDiffFileSides(dir, file, r.diff_source, r.base_ref);
        setSides(s);
        void loadFiles(r);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [absPath, backend, dir, loadFiles]);
  // saveEdit changes identity; hold the latest in a ref for the Monaco command.
  const saveEditRef = useRef(saveEdit);
  saveEditRef.current = saveEdit;

  const onDiffMount = useCallback(
    (editor: MonacoNs.editor.IStandaloneDiffEditor, monaco: typeof MonacoNs) => {
      const modified = editor.getModifiedEditor();
      modifiedEditorRef.current = modified;
      // Signal (once, deferred) that the editor ref is ready so the view-zone
      // effect re-runs. Deferred to avoid a setState during DiffEditor render.
      if (!editorReadyBumpedRef.current) {
        editorReadyBumpedRef.current = true;
        queueMicrotask(() => setEditorReadyToken((t) => t + 1));
      }
      modified.onDidChangeCursorSelection((e) => {
        const file = selectedFileRef.current;
        if (!file) return;
        const sel = e.selection;
        // Only surface the floating "+ Comment" button for a real (non-empty)
        // selection, matching the Repo Explorer file-comment UX.
        const empty =
          sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
        if (empty) {
          setSelectionAnchor(null);
          return;
        }
        const start = Math.min(sel.startLineNumber, sel.endLineNumber);
        const end = Math.max(sel.startLineNumber, sel.endLineNumber);
        setSelectionAnchor({ start, end });
      });
      // In-place edit: track dirty + Ctrl+S save when the modified side is editable.
      modified.onDidChangeModelContent(() => {
        if (!editableRef.current) return;
        setDirty((modified.getModel()?.getValue() ?? "") !== sidesAfterRef.current);
      });
      modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveEditRef.current();
      });
    },
    [],
  );

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
    const file = selectedFileRef.current;
    if (!r || !file || !composer || !composer.body.trim()) return;
    const lines = (modifiedEditorRef.current?.getModel()?.getValue() ?? sidesAfterRef.current).split(/\r?\n/);
    const code = lines.slice(composer.start - 1, composer.end).join("\n") || null;
    setBusy(true);
    try {
      await backend.addReviewComment(
        workstreamId,
        r.id,
        file,
        composer.start,
        "new",
        code,
        null,
        composer.body.trim(),
      );
      setComposer(null);
      setSelectionAnchor(null);
      await loadComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [backend, workstreamId, composer, loadComments]);

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
  setStatusRef.current = setStatus;

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
        {review && (
          <button
            style={styles.btn}
            disabled={busy || syncing}
            onClick={() => void syncComments()}
            data-testid="sync-review"
            title="Re-read comments from the session database"
          >
            <ArrowPathIcon width={14} height={14} /> {syncing ? "Syncing…" : "Sync"}
          </button>
        )}
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
                  {editable && dirty && <span style={styles.dirtyDot} data-testid="edit-dirty-dot" />}
                  {editable && (
                    <button
                      style={styles.btn}
                      disabled={saving || !dirty}
                      onClick={() => void saveEdit()}
                      data-testid="save-edit"
                      title="Save edits to the working file (Ctrl+S)"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                  )}
                </div>
                <div className={INTERACTIVE_ZONES_CLASS} style={{ flex: 1, minHeight: 0, position: "relative" }}>
                  {!monacoReady ? (
                    <div style={{ padding: 12, color: "#6c7086" }}>Loading editor…</div>
                  ) : (
                  <DiffEditor
                    key={selectedFile}
                    height="100%"
                    language={detectLanguage(selectedFile)}
                    original={sides.before}
                    modified={sides.after}
                    theme={GITHUB_DARK_DIFF_THEME}
                    beforeMount={defineGithubDiffTheme}
                    onMount={onDiffMount}
                    options={{
                      readOnly: !editable,
                      originalEditable: false,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      overviewRulerBorder: false,
                    }}
                  />
                  )}
                  {/* Floating "+ Comment" button on a non-empty selection. */}
                  {review.status === "open" && selectionAnchor && !composer && (
                    <button
                      data-testid="add-comment-floating"
                      onClick={() =>
                        setComposer({ start: selectionAnchor.start, end: selectionAnchor.end, body: "" })
                      }
                      style={styles.floatingBtn}
                    >
                      + Comment ({selectionAnchor.start}
                      {selectionAnchor.start !== selectionAnchor.end ? `-${selectionAnchor.end}` : ""})
                    </button>
                  )}
                  {/* Floating inline composer. */}
                  {composer && (
                    <div style={styles.floatingComposer} data-testid="comment-composer">
                      <div style={{ fontSize: 10, color: "#a6adc8" }}>
                        Lines {composer.start}
                        {composer.start !== composer.end ? `-${composer.end}` : ""}
                      </div>
                      <textarea
                        data-testid="comment-body"
                        autoFocus
                        rows={5}
                        style={styles.textarea}
                        placeholder="Comment (markdown)"
                        value={composer.body}
                        onChange={(e) =>
                          setComposer((cur) => (cur ? { ...cur, body: e.target.value } : cur))
                        }
                      />
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                        <button
                          style={styles.btn}
                          disabled={busy}
                          onClick={() => setComposer(null)}
                          data-testid="comment-cancel"
                        >
                          Cancel
                        </button>
                        <button
                          style={styles.btnPrimary}
                          disabled={busy || composer.body.trim().length === 0}
                          onClick={addComment}
                          data-testid="add-comment"
                        >
                          Comment
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={styles.center}>Pick a file to review.</div>
            )}
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
  dirtyDot: { width: 8, height: 8, borderRadius: "50%", background: "#f9e2af", flexShrink: 0 },
  textarea: { minHeight: 48, background: "#11111b", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 4, padding: 6, fontFamily: "monospace", fontSize: 12, resize: "vertical" },
  muted: { color: "#6c7086", fontSize: 12, padding: 8, fontStyle: "italic" },
  floatingBtn: {
    position: "absolute", top: 8, right: 16, padding: "4px 10px", background: "#89b4fa",
    color: "#11111b", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 11,
    fontWeight: 600, boxShadow: "0 2px 6px rgba(0,0,0,0.4)", zIndex: 5,
  },
  floatingComposer: {
    position: "absolute", top: 8, right: 16, width: 360, background: "#1e1e2e",
    border: "1px solid #45475a", borderRadius: 6, padding: 10,
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)", zIndex: 10, display: "flex",
    flexDirection: "column", gap: 8,
  },
};
