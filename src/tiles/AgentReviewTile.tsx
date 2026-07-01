// @test-skip: covered by src/tiles/__tests__/AgentReviewTile.test.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ArrowUturnLeftIcon,
  PlusCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useBackend } from "../backend/context";
import { MarkdownView } from "../ui/MarkdownView";
import {
  REVIEW_EVENTS,
  type AgentReview,
  type ReviewComment,
} from "../domain/agent-review";
import {
  groupThreads,
  basename,
  isOpenThread,
  attentionCount,
  allThreadsClosed,
  statusLabel,
  type ReviewThread,
} from "../domain/agent-review-view";

interface Props {
  tileId: string;
  isFocused: boolean;
  workstreamId: string;
  reviewId?: string;
}

/**
 * Agent Review tile (ADR 013) — reviewer↔agent loop surface. Renders each
 * comment thread with its anchored code, the per-comment before/after when the
 * commented code changed, replies, and resolve/reopen controls. SQLite is the
 * source of truth; `review:*` events trigger a reload.
 */
export default function AgentReviewTile({ workstreamId, reviewId: reviewIdProp }: Props) {
  const backend = useBackend();
  const [review, setReview] = useState<AgentReview | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ path: "", start: "", end: "", body: "" });
  const reviewIdRef = useRef<string | null>(reviewIdProp ?? null);

  const reload = useCallback(async () => {
    const id = reviewIdRef.current;
    if (!id) return;
    try {
      const list = await backend.listReviewComments(id);
      setComments(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [backend]);

  // Ensure a review exists (idempotent) then load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // If the tile was opened with a specific review, use it; otherwise
        // create-or-focus the workstream's single active review (idempotent).
        let id = reviewIdProp ?? null;
        if (!id) {
          const active = await backend.createAgentReview(workstreamId);
          if (cancelled) return;
          setReview(active);
          id = active.id;
        }
        reviewIdRef.current = id;
        await reload();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workstreamId, reviewIdProp]);

  // Live refresh on backend events.
  useEffect(() => {
    let un1: UnlistenFn | undefined;
    let un2: UnlistenFn | undefined;
    (async () => {
      un1 = await listen(REVIEW_EVENTS.COMMENT_UPDATED, () => void reload());
      un2 = await listen(REVIEW_EVENTS.ROUND_READY, () => {
        void reload();
        const id = reviewIdRef.current;
        if (id) backend.listReviewComments(id).catch(() => {});
      });
    })();
    return () => {
      un1?.();
      un2?.();
    };
  }, [backend, reload]);

  const threads: ReviewThread[] = useMemo(() => groupThreads(comments), [comments]);
  const attention = attentionCount(threads);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const completable = allThreadsClosed(threads) && review?.status !== "completed";

  const completeReview = useCallback(async () => {
    const id = reviewIdRef.current;
    if (!id) return;
    setBusy(true);
    try {
      const path = await backend.completeAgentReview(id);
      setExportedPath(path);
      setReview((r) => (r ? { ...r, status: "completed", exported_path: path } : r));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [backend]);

  const submitRound = useCallback(async () => {
    const id = reviewIdRef.current;
    if (!id) return;
    setBusy(true);
    try {
      await backend.submitReviewRound(id);
      // Round bump is async in the real backend (bg sweep emits round-ready);
      // reload after a beat as a fallback for the in-memory backend.
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [backend, reload]);

  const addComment = useCallback(async () => {
    const id = reviewIdRef.current;
    if (!id) return;
    const start = parseInt(draft.start, 10);
    const end = parseInt(draft.end || draft.start, 10);
    if (!draft.path.trim() || Number.isNaN(start) || !draft.body.trim()) {
      setError("path, start line, and comment body are required");
      return;
    }
    setBusy(true);
    try {
      await backend.addReviewComment(id, draft.path.trim(), start, end, draft.body.trim());
      setDraft({ path: "", start: "", end: "", body: "" });
      setAdding(false);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [backend, draft, reload]);

  const reply = useCallback(
    async (parentId: string, author: "me" | "agent") => {
      const body = (replyDrafts[parentId] ?? "").trim();
      if (!body) return;
      setBusy(true);
      try {
        await backend.replyReviewComment(parentId, body, author);
        setReplyDrafts((d) => ({ ...d, [parentId]: "" }));
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [backend, replyDrafts, reload],
  );

  const setResolution = useCallback(
    async (commentId: string, status: string) => {
      setBusy(true);
      try {
        await backend.setCommentResolution(commentId, status, "me");
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [backend, reload],
  );

  return (
    <div data-testid="agent-review-tile" style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Agent Review</span>
        {review && <span style={styles.round}>round {review.round}</span>}
        {attention > 0 && (
          <span data-testid="attention-badge" style={styles.badge} title="threads whose code changed">
            <ExclamationTriangleIcon width={12} height={12} /> {attention}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button style={styles.btn} disabled={busy} onClick={() => setAdding((a) => !a)}>
          <PlusCircleIcon width={14} height={14} /> Comment
        </button>
        <button style={styles.btn} disabled={busy} onClick={submitRound} title="re-anchor open comments against the latest commit">
          <ArrowPathIcon width={14} height={14} /> Submit round
        </button>
        {completable && (
          <button style={styles.btnPrimary} disabled={busy} onClick={completeReview} data-testid="complete-review">
            Complete
          </button>
        )}
      </div>

      {exportedPath && (
        <div style={styles.exported} data-testid="exported-path">
          Review complete — summary written to {exportedPath}
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {adding && (
        <div style={styles.addForm} data-testid="add-comment-form">
          <input
            style={styles.input}
            placeholder="absolute file path"
            value={draft.path}
            onChange={(e) => setDraft((d) => ({ ...d, path: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <input
              style={{ ...styles.input, width: 80 }}
              placeholder="line"
              value={draft.start}
              onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
            />
            <input
              style={{ ...styles.input, width: 80 }}
              placeholder="end (opt)"
              value={draft.end}
              onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))}
            />
          </div>
          <textarea
            style={styles.textarea}
            placeholder="comment (markdown)"
            value={draft.body}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />
          <button style={styles.btnPrimary} disabled={busy} onClick={addComment}>
            Add comment
          </button>
        </div>
      )}

      <div style={styles.list}>
        {threads.length === 0 && <div style={styles.empty}>No review comments yet.</div>}
        {threads.map((t) => {
          const changed = t.root.anchor_state === "changed";
          const open = isOpenThread(t.root);
          return (
            <div key={t.root.id} style={styles.thread} data-testid="review-thread">
              <div style={styles.threadHead}>
                <span style={styles.anchor}>
                  {basename(t.root.absolute_path)}:{t.root.anchor_line_start}
                </span>
                <span
                  style={{ ...styles.statusChip, ...(open ? {} : styles.statusChipClosed) }}
                  data-testid="thread-status"
                >
                  {statusLabel(t.root.status)}
                </span>
                {changed && (
                  <span style={styles.changedChip} data-testid="changed-badge">
                    code changed
                    {t.root.fixing_commit ? ` · ${t.root.fixing_commit}` : ""}
                  </span>
                )}
              </div>

              {t.root.anchor_text && <pre style={styles.code}>{t.root.anchor_text}</pre>}
              <div style={styles.body}>
                <MarkdownView>{t.root.body_md}</MarkdownView>
              </div>

              {changed && t.root.fixing_hunk && (
                <details style={styles.beforeAfter} data-testid="before-after">
                  <summary>What changed (fixing diff)</summary>
                  <pre style={styles.hunk}>{t.root.fixing_hunk}</pre>
                </details>
              )}

              {t.replies.map((rep) => (
                <div key={rep.id} style={styles.reply} data-testid="thread-reply">
                  <span style={styles.author}>{rep.author}</span>
                  <div style={styles.body}>
                    <MarkdownView>{rep.body_md}</MarkdownView>
                  </div>
                </div>
              ))}

              <div style={styles.replyRow}>
                <input
                  style={styles.input}
                  placeholder="reply…"
                  value={replyDrafts[t.root.id] ?? ""}
                  onChange={(e) =>
                    setReplyDrafts((d) => ({ ...d, [t.root.id]: e.target.value }))
                  }
                />
                <button style={styles.btn} disabled={busy} onClick={() => reply(t.root.id, "me")}>
                  Reply
                </button>
                {open ? (
                  <button
                    style={styles.btn}
                    disabled={busy}
                    onClick={() => setResolution(t.root.id, "resolved")}
                    title="mark this thread resolved"
                  >
                    <CheckCircleIcon width={14} height={14} /> Resolve
                  </button>
                ) : (
                  <button
                    style={styles.btn}
                    disabled={busy}
                    onClick={() => setResolution(t.root.id, "open")}
                    title="reopen this thread"
                  >
                    <ArrowUturnLeftIcon width={14} height={14} /> Reopen
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", background: "#1e1e2e", color: "#cdd6f4", fontSize: 13 },
  header: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid #313244" },
  title: { fontWeight: 600 },
  round: { color: "#a6adc8", fontSize: 12 },
  badge: { display: "inline-flex", alignItems: "center", gap: 3, background: "#f9e2af", color: "#1e1e2e", borderRadius: 8, padding: "1px 6px", fontSize: 11, fontWeight: 600 },
  btn: { display: "inline-flex", alignItems: "center", gap: 4, background: "#313244", color: "#cdd6f4", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 12 },
  btnPrimary: { alignSelf: "flex-start", background: "#89b4fa", color: "#1e1e2e", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600 },
  error: { color: "#f38ba8", padding: "6px 10px", fontSize: 12 },
  exported: { color: "#a6e3a1", padding: "6px 10px", fontSize: 12 },
  addForm: { display: "flex", flexDirection: "column", gap: 6, padding: 10, borderBottom: "1px solid #313244" },
  input: { flex: 1, background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 6, padding: "4px 8px", fontSize: 12 },
  textarea: { minHeight: 60, background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 6, padding: "4px 8px", fontSize: 12, fontFamily: "inherit" },
  list: { flex: 1, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 10 },
  empty: { color: "#6c7086", fontStyle: "italic" },
  thread: { border: "1px solid #313244", borderRadius: 8, padding: 10 },
  threadHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  anchor: { fontFamily: "monospace", color: "#89dceb", fontSize: 12 },
  statusChip: { background: "#313244", color: "#cdd6f4", borderRadius: 6, padding: "1px 6px", fontSize: 11 },
  statusChipClosed: { background: "#a6e3a1", color: "#1e1e2e" },
  changedChip: { background: "#fab387", color: "#1e1e2e", borderRadius: 6, padding: "1px 6px", fontSize: 11, fontWeight: 600 },
  code: { background: "#181825", borderRadius: 6, padding: 8, overflowX: "auto", fontSize: 12, margin: "4px 0" },
  body: { fontSize: 13 },
  beforeAfter: { background: "#181825", borderRadius: 6, padding: 8, margin: "6px 0" },
  hunk: { whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12, margin: 0 },
  reply: { borderLeft: "2px solid #45475a", paddingLeft: 8, margin: "6px 0" },
  author: { color: "#f9e2af", fontSize: 11, fontWeight: 600 },
  replyRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 8 },
};
