import { useMemo, useState } from "react";
import {
  ChatBubbleLeftRightIcon,
  ExclamationTriangleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";

import type { SessionFileComment } from "../domain/file-comments";
import {
  detectDrift,
  filterComments,
  groupByFile,
  type CommentFilters,
} from "../domain/comment-navigation";
import { formatAuthor } from "./comments-layer";

export interface CommentsPanelProps {
  /** Every comment in the workstream (roots + replies), pre-ordered. */
  comments: SessionFileComment[];
  selectedId: string | null;
  /** Fired with the thread ROOT — the panel is navigation-only. */
  onSelect: (comment: SessionFileComment) => void;
  /** True when the workstream has no linked Copilot session. */
  unbound?: boolean;
  /**
   * Current content of already-loaded files, keyed by repo-relative path, used
   * to badge drifted anchors. Files absent here simply aren't checked, so the
   * tab never has to read every commented file up front.
   */
  fileLines?: Record<string, string[] | undefined>;
  filters?: CommentFilters;
  onFiltersChange?: (filters: CommentFilters) => void;
  /**
   * Delete a whole thread, given its root. Optional; the control is hidden
   * when absent so the panel stays usable in read-only contexts.
   *
   * Offered on **every** thread, not just this user's own. Deleting an
   * imported row removes a local copy of somebody else's words -- the source
   * review is untouched -- and those are exactly the threads that most need
   * clearing out once handled. Confirmation is the caller's job.
   */
  onDelete?: (root: SessionFileComment) => void;
}

const DEFAULT_FILTERS: CommentFilters = { statuses: [], authors: [], text: "" };

/**
 * Left pane of the Repo Explorer **Comments tab**: every comment in the
 * workstream, grouped by file, one row per thread root.
 *
 * Navigation-first: **no resolve or reply here**. Those actions live in the
 * editor's view zone, so there is exactly one code path for editing a comment
 * and for changing its status. Resolved threads stay in the list (dimmed)
 * rather than disappearing under the cursor; the status filter decides
 * visibility.
 *
 * Delete is the deliberate exception. It is cleanup rather than participation
 * in a conversation, the list is where a thread whose file has moved or gone
 * is actually discoverable, and clearing several handled threads one at a time
 * through the editor means loading each file first.
 */
export function CommentsPanel({
  comments,
  selectedId,
  onSelect,
  unbound = false,
  fileLines,
  filters: controlledFilters,
  onFiltersChange,
  onDelete,
}: CommentsPanelProps) {
  const [localFilters, setLocalFilters] = useState<CommentFilters>(DEFAULT_FILTERS);
  const filters = controlledFilters ?? localFilters;
  const setFilters = (next: CommentFilters) => {
    setLocalFilters(next);
    onFiltersChange?.(next);
  };

  const authors = useMemo(
    () => [...new Set(comments.map((c) => c.author))].sort((a, b) => a.localeCompare(b)),
    [comments],
  );
  const statuses = useMemo(
    () => [...new Set(comments.map((c) => c.status))].sort((a, b) => a.localeCompare(b)),
    [comments],
  );
  const groups = useMemo(
    () => groupByFile(filterComments(comments, filters)),
    [comments, filters],
  );

  if (unbound) {
    return (
      <div style={panelStyle} data-testid="comments-panel">
        <div style={emptyStyle} data-testid="comments-unbound">
          Open a Copilot session in this workstream to use comments.
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle} data-testid="comments-panel">
      <div style={toolbarStyle}>
        <input
          data-testid="comments-filter-text"
          value={filters.text}
          onChange={(e) => setFilters({ ...filters, text: e.target.value })}
          placeholder="Filter comments…"
          style={inputStyle}
        />
        <div style={{ display: "flex", gap: 4 }}>
          <select
            data-testid="comments-filter-status"
            value={filters.statuses[0] ?? ""}
            onChange={(e) =>
              setFilters({ ...filters, statuses: e.target.value ? [e.target.value] : [] })
            }
            style={selectStyle}
          >
            <option value="">Any status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            data-testid="comments-filter-author"
            value={filters.authors[0] ?? ""}
            onChange={(e) =>
              setFilters({ ...filters, authors: e.target.value ? [e.target.value] : [] })
            }
            style={selectStyle}
          >
            <option value="">Any author</option>
            {authors.map((a) => (
              <option key={a} value={a}>{formatAuthor(a)}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {groups.length === 0 && (
          <div style={emptyStyle} data-testid="comments-empty">
            No comments match these filters.
          </div>
        )}
        {groups.map((group) => (
          <div key={group.file} data-testid={`comments-file-${group.file}`}>
            <div style={fileHeaderStyle} title={group.file}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {group.file}
              </span>
              <span style={{ color: "#585b70" }}>{group.threadCount}</span>
            </div>
            {group.threads.map(({ root, replyCount }) => {
              const selected = root.id === selectedId;
              const closed = root.status === "resolved" || root.status === "wontfix";
              const drift = detectDrift(root, fileLines?.[root.file]);
              return (
                <div
                  key={root.id}
                  role="button"
                  tabIndex={0}
                  data-testid={`comments-thread-${root.id}`}
                  data-selected={selected ? "true" : "false"}
                  data-closed={closed ? "true" : "false"}
                  onClick={() => onSelect(root)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(root);
                    }
                  }}
                  style={{
                    ...rowStyle,
                    background: selected ? "#313244" : "transparent",
                    borderLeft: selected ? "2px solid #89b4fa" : "2px solid transparent",
                    opacity: closed ? 0.55 : 1,
                  }}
                >
                  <div style={rowMetaStyle}>
                    <span style={{ color: "#89b4fa" }}>{formatAuthor(root.author)}</span>
                    <span>:{root.anchor_line_start}</span>
                    {drift === "drifted" && (
                      <ExclamationTriangleIcon
                        data-testid={`comments-drift-${root.id}`}
                        title="The code at this line changed since the comment was written"
                        style={{ width: 11, height: 11, color: "#f9e2af" }}
                      />
                    )}
                    <div style={{ flex: 1 }} />
                    {replyCount > 0 && (
                      <span style={replyBadgeStyle} title={`${replyCount} replies`}>
                        <ChatBubbleLeftRightIcon style={{ width: 10, height: 10 }} />
                        {replyCount}
                      </span>
                    )}
                    {onDelete && (
                      <button
                        data-testid={`comments-delete-${root.id}`}
                        // The row itself navigates, so this must not bubble --
                        // otherwise deleting also opens the file being deleted
                        // from.
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(root);
                        }}
                        title={
                          replyCount > 0
                            ? `Delete this comment and its ${replyCount} replies`
                            : "Delete this comment"
                        }
                        style={deleteButtonStyle}
                      >
                        <TrashIcon style={{ width: 11, height: 11 }} />
                      </button>
                    )}
                  </div>
                  <div
                    style={{
                      ...bodyStyle,
                      textDecoration: closed ? "line-through" : "none",
                    }}
                  >
                    {root.body}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: 240,
  minWidth: 160,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid #313244",
  background: "#181825",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: 6,
  borderBottom: "1px solid #313244",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "3px 6px",
  fontSize: 11,
  color: "#cdd6f4",
  background: "#11111b",
  border: "1px solid #313244",
  borderRadius: 3,
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "2px 4px",
  fontSize: 10,
  color: "#89b4fa",
  background: "#11111b",
  border: "1px solid #313244",
  borderRadius: 3,
};

const fileHeaderStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  padding: "4px 8px",
  fontSize: 10,
  color: "#a6adc8",
  background: "#11111b",
  position: "sticky",
  top: 0,
};

const rowStyle: React.CSSProperties = {
  padding: "5px 8px",
  cursor: "pointer",
  borderBottom: "1px solid #1e1e2e",
};

const rowMetaStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 9,
  color: "#6c7086",
  marginBottom: 2,
};

const replyBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  color: "#a6adc8",
};

const bodyStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#cdd6f4",
  overflow: "hidden",
  textOverflow: "ellipsis",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

const emptyStyle: React.CSSProperties = {
  padding: "10px 8px",
  fontSize: 11,
  color: "#585b70",
};

const deleteButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#6c7086",
  cursor: "pointer",
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
};
