import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type * as MonacoNs from "monaco-editor";

import type { SessionFileComment } from "../domain/file-comments";
import { writeTextToClipboard } from "../domain/clipboard";
import { markInteractiveZoneNode } from "../ui/interactive-zones";
import {
  estimateThreadHeightInLines,
  formatCommentMeta,
  formatThreadForCopy,
  groupCommentThreads,
  isClosedStatus,
  isMutable,
  selectionToAnchor,
  type Anchor,
  type CommentThread,
} from "./comments-layer";

export interface FileCommentActions {
  onAddComment?: (
    start: number,
    end: number,
    anchorText: string | null,
    body: string,
  ) => Promise<unknown>;
  onUpdateComment?: (id: string, body: string) => Promise<unknown>;
  onReplyComment?: (parentId: string, body: string) => Promise<unknown>;
  onDeleteComment?: (id: string) => Promise<unknown>;
  onSetCommentStatus?: (id: string, status: string) => Promise<unknown>;
}

export interface FileCommentsLayerProps extends FileCommentActions {
  editor: MonacoNs.editor.ICodeEditor | null;
  editorReadyToken: number;
  comments: SessionFileComment[];
  enabled: boolean;
}

type Composer =
  | { mode: "create"; anchor: Anchor; body: string }
  | { mode: "edit"; comment: SessionFileComment; body: string }
  | { mode: "reply"; parentId: string; anchorLine: number; body: string };

/**
 * Adds the shared file-comment interaction model to an existing Monaco editor.
 *
 * The caller owns the editor and must apply `INTERACTIVE_ZONES_CLASS` to its
 * host while this layer is enabled. Keeping that host concern outside lets the
 * same layer work with a standalone editor and a DiffEditor's modified side.
 */
export function FileCommentsLayer({
  editor,
  editorReadyToken,
  comments,
  enabled,
  onAddComment,
  onUpdateComment,
  onReplyComment,
  onDeleteComment,
  onSetCommentStatus,
}: FileCommentsLayerProps): ReactElement | null {
  const [selectionAnchor, setSelectionAnchor] = useState<Anchor | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [composerSaving, setComposerSaving] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const composerRequestRef = useRef(0);
  const zoneIdsRef = useRef<Map<string, string>>(new Map());
  const zoneNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const zoneDescriptorsRef = useRef<Map<string, MonacoNs.editor.IViewZone>>(new Map());
  const measureRafRef = useRef<number | null>(null);

  const handleEditClick = useCallback((comment: SessionFileComment) => {
    setComposer({ mode: "edit", comment, body: comment.body });
  }, []);

  const handleReplyClick = useCallback((comment: SessionFileComment) => {
    setComposer({
      mode: "reply",
      parentId: comment.id,
      anchorLine: comment.anchor_line_start,
      body: "",
    });
  }, []);

  const handleCopyThread = useCallback((thread: CommentThread) => {
    void writeTextToClipboard(formatThreadForCopy(thread));
  }, []);

  const handleDeleteClick = useCallback(
    (comment: SessionFileComment) => {
      if (!onDeleteComment || !window.confirm("Delete this comment?")) return;
      void onDeleteComment(comment.id);
    },
    [onDeleteComment],
  );

  const handleStatusClick = useCallback(
    (comment: SessionFileComment, status: string) => {
      if (!onSetCommentStatus) return;
      void onSetCommentStatus(comment.id, status);
    },
    [onSetCommentStatus],
  );

  const renderCommentZone = useCallback(
    (node: HTMLDivElement, thread: CommentThread): void => {
      node.innerHTML = "";
      markInteractiveZoneNode(node);

      const makeButton = (
        label: string,
        color: string,
        testId: string,
        onClick: () => void,
      ): HTMLButtonElement => {
        const button = document.createElement("button");
        button.textContent = label;
        button.dataset.testid = testId;
        Object.assign(button.style, {
          background: "none",
          border: "1px solid #45475a",
          color,
          borderRadius: "3px",
          padding: "1px 6px",
          cursor: "pointer",
          fontSize: "10px",
          pointerEvents: "auto",
        });
        button.addEventListener("mousedown", (event) => event.stopPropagation());
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          event.preventDefault();
          onClick();
        });
        return button;
      };

      const appendEntry = (comment: SessionFileComment, isReply: boolean): void => {
        const wrapper = document.createElement("div");
        if (isReply) {
          wrapper.style.marginTop = "6px";
          wrapper.style.paddingLeft = "10px";
          wrapper.style.borderLeft = "2px solid #45475a";
        }
        wrapper.dataset.testid = `comment-entry-${comment.id}`;

        const header = document.createElement("div");
        Object.assign(header.style, {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "4px",
          color: "#a6adc8",
          fontSize: "10px",
        });
        const meta = document.createElement("span");
        meta.textContent = formatCommentMeta(comment);
        meta.dataset.testid = `comment-meta-${comment.id}`;
        if (isClosedStatus(comment.status)) {
          meta.style.textDecoration = "line-through";
          meta.style.opacity = "0.7";
        }
        header.appendChild(meta);
        const spacer = document.createElement("span");
        spacer.style.flex = "1";
        header.appendChild(spacer);

        if (isMutable(comment)) {
          if (onSetCommentStatus) {
            header.appendChild(
              isClosedStatus(comment.status)
                ? makeButton("Reopen", "#a6e3a1", `comment-reopen-${comment.id}`, () =>
                    handleStatusClick(comment, "open"),
                  )
                : makeButton("Resolve", "#a6e3a1", `comment-resolve-${comment.id}`, () =>
                    handleStatusClick(comment, "resolved"),
                  ),
            );
          }
          header.appendChild(
            makeButton("Edit", "#89b4fa", `comment-edit-${comment.id}`, () =>
              handleEditClick(comment),
            ),
          );
          header.appendChild(
            makeButton("Delete", "#f38ba8", `comment-delete-${comment.id}`, () =>
              handleDeleteClick(comment),
            ),
          );
        }
        if (!isReply) {
          if (onReplyComment) {
            header.appendChild(
              makeButton("Reply", "#89b4fa", `comment-reply-${comment.id}`, () =>
                handleReplyClick(comment),
              ),
            );
          }
          header.appendChild(
            makeButton("Copy", "#a6adc8", `comment-copy-${comment.id}`, () =>
              handleCopyThread(thread),
            ),
          );
        }
        wrapper.appendChild(header);

        const body = document.createElement("div");
        Object.assign(body.style, {
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: "1.5",
          userSelect: "text",
          cursor: "text",
        });
        (body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect =
          "text";
        body.dataset.testid = `comment-body-${comment.id}`;
        body.addEventListener("mousedown", (event) => event.stopPropagation());
        body.textContent = comment.body;
        wrapper.appendChild(body);
        node.appendChild(wrapper);
      };

      appendEntry(thread.root, false);
      for (const reply of thread.replies) appendEntry(reply, true);
    },
    [
      handleCopyThread,
      handleDeleteClick,
      handleEditClick,
      handleReplyClick,
      handleStatusClick,
      onReplyComment,
      onSetCommentStatus,
    ],
  );

  useEffect(() => {
    if (!editor) {
      zoneIdsRef.current.clear();
      zoneNodesRef.current.clear();
      return;
    }
    if (!enabled) {
      if (zoneIdsRef.current.size > 0) {
        editor.changeViewZones((accessor) => {
          for (const zoneId of zoneIdsRef.current.values()) accessor.removeZone(zoneId);
        });
      }
      zoneIdsRef.current.clear();
      zoneNodesRef.current.clear();
      zoneDescriptorsRef.current.clear();
      return;
    }

    editor.changeViewZones((accessor) => {
      for (const zoneId of zoneIdsRef.current.values()) accessor.removeZone(zoneId);
      zoneIdsRef.current.clear();
      zoneNodesRef.current.clear();
      zoneDescriptorsRef.current.clear();
      for (const thread of groupCommentThreads(comments)) {
        const comment = thread.root;
        const slot = document.createElement("div");
        const content = document.createElement("div");
        Object.assign(content.style, {
          background: "#1e1e2e",
          borderTop: "1px solid #313244",
          borderBottom: "1px solid #313244",
          padding: "6px 12px 8px",
          fontFamily: "system-ui, sans-serif",
          fontSize: "11px",
          color: "#cdd6f4",
        });
        content.dataset.testid = `comment-zone-${comment.id}`;
        content.dataset.commentId = comment.id;
        renderCommentZone(content, thread);
        slot.appendChild(content);
        zoneNodesRef.current.set(comment.id, content);

        const descriptor: MonacoNs.editor.IViewZone = {
          afterLineNumber: comment.anchor_line_end,
          heightInLines: estimateThreadHeightInLines(thread),
          domNode: slot,
          suppressMouseDown: true,
        };
        const zoneId = accessor.addZone(descriptor);
        zoneIdsRef.current.set(comment.id, zoneId);
        zoneDescriptorsRef.current.set(comment.id, descriptor);
      }
    });

    if (measureRafRef.current !== null) cancelAnimationFrame(measureRafRef.current);
    const entries = Array.from(zoneIdsRef.current.entries()).map(([commentId, zoneId]) => ({
      zoneId,
      node: zoneNodesRef.current.get(commentId),
      descriptor: zoneDescriptorsRef.current.get(commentId),
    }));
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = null;
      if (entries.length === 0) return;
      editor.changeViewZones((accessor) => {
        for (const { zoneId, node, descriptor } of entries) {
          if (!node || !descriptor) continue;
          const measured = node.offsetHeight;
          if (measured > 0 && descriptor.heightInPx !== measured) {
            descriptor.heightInPx = measured;
            descriptor.heightInLines = undefined;
            accessor.layoutZone(zoneId);
          }
        }
      });
    });

    return () => {
      if (zoneIdsRef.current.size > 0) {
        editor.changeViewZones((accessor) => {
          for (const zoneId of zoneIdsRef.current.values()) accessor.removeZone(zoneId);
        });
      }
      if (measureRafRef.current !== null) {
        cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = null;
      }
      zoneIdsRef.current.clear();
      zoneNodesRef.current.clear();
      zoneDescriptorsRef.current.clear();
    };
  }, [comments, editor, editorReadyToken, enabled, renderCommentZone]);

  useEffect(() => {
    if (!editor || !enabled || !onAddComment) {
      setSelectionAnchor(null);
      return;
    }
    const disposable = editor.onDidChangeCursorSelection((event) => {
      const selection = event.selection;
      if (!selection || selection.isEmpty()) {
        setSelectionAnchor(null);
        return;
      }
      const model = editor.getModel();
      if (!model) return;
      setSelectionAnchor(
        selectionToAnchor(
          model.getValue().split(/\r?\n/),
          selection.startLineNumber,
          selection.endLineNumber,
        ),
      );
    });
    return () => disposable.dispose();
  }, [editor, editorReadyToken, enabled, onAddComment]);

  if (!enabled) return null;

  return (
    <>
      {onAddComment && selectionAnchor && !composer ? (
        <button
          data-testid="add-comment-floating"
          onClick={() => {
            setComposerError(null);
            setComposer({ mode: "create", anchor: selectionAnchor, body: "" });
          }}
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
          + Comment ({selectionAnchor.start}
          {selectionAnchor.start !== selectionAnchor.end ? `-${selectionAnchor.end}` : ""})
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
              : composer.mode === "reply"
                ? `Replying to comment on line ${composer.anchorLine}`
                : `Editing comment on line ${composer.comment.anchor_line_start}`}
          </div>
          <textarea
            data-testid="comment-composer-textarea"
            autoFocus
            rows={5}
            value={composer.body}
            onChange={(event) =>
              setComposer((current) =>
                current ? { ...current, body: event.target.value } : current,
              )
            }
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
          {composerError ? (
            <div
              data-testid="comment-composer-error"
              role="alert"
              style={{ color: "#f38ba8", fontSize: 11 }}
            >
              {composerError}
            </div>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button
              data-testid="comment-composer-cancel"
              onClick={() => {
                composerRequestRef.current += 1;
                setComposerSaving(false);
                setComposerError(null);
                setComposer(null);
              }}
              style={{
                background: "none",
                border: "1px solid #45475a",
                color: "#a6adc8",
                borderRadius: 4,
                padding: "3px 10px",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Cancel
            </button>
            <button
              data-testid="comment-composer-save"
              disabled={composerSaving || composer.body.trim().length === 0}
              onClick={async () => {
                const body = composer.body.trim();
                if (body.length === 0) return;
                const request = ++composerRequestRef.current;
                setComposerSaving(true);
                setComposerError(null);
                try {
                  if (composer.mode === "create" && onAddComment) {
                    await onAddComment(
                      composer.anchor.start,
                      composer.anchor.end,
                      composer.anchor.anchorText,
                      body,
                    );
                  } else if (composer.mode === "edit" && onUpdateComment) {
                    await onUpdateComment(composer.comment.id, body);
                  } else if (composer.mode === "reply" && onReplyComment) {
                    await onReplyComment(composer.parentId, body);
                  } else {
                    throw new Error("Comment action is unavailable.");
                  }
                  if (request !== composerRequestRef.current) return;
                  setComposer(null);
                  setSelectionAnchor(null);
                } catch (error) {
                  if (request !== composerRequestRef.current) return;
                  setComposerError(error instanceof Error ? error.message : String(error));
                } finally {
                  if (request === composerRequestRef.current) setComposerSaving(false);
                }
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
              {composerSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
