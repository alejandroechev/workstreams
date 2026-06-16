import { useState } from "react";

interface Props {
  workstreamName: string;
  /** Whether the workstream is worktree-backed (controls whether the
   *  delete-worktree checkbox is shown at all). */
  isWorktree: boolean;
  onConfirm: (deleteWorktree: boolean) => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog shown when archiving a workstream. For
 * worktree-backed workstreams it offers a "delete the worktree
 * directory" checkbox (default ON) so the sibling folder doesn't linger
 * after the workstream is archived.
 */
export function ArchiveWorkstreamDialog({ workstreamName, isWorktree, onConfirm, onCancel }: Props) {
  const [deleteWorktree, setDeleteWorktree] = useState(true);

  return (
    <div
      data-testid="archive-workstream-dialog"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e2e",
          color: "#cdd6f4",
          border: "1px solid #313244",
          borderRadius: 6,
          padding: 18,
          minWidth: 360,
          maxWidth: 460,
          fontFamily: "monospace",
          fontSize: 13,
        }}
      >
        <div style={{ fontSize: 14, color: "#89b4fa", marginBottom: 10 }}>Archive workstream</div>
        <div style={{ marginBottom: 14 }}>
          Archive <strong>{workstreamName}</strong>? It will move to the archived
          section and its tiles will be closed.
        </div>

        {isWorktree && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer" }}>
            <input
              data-testid="archive-delete-worktree"
              type="checkbox"
              checked={deleteWorktree}
              onChange={(e) => setDeleteWorktree(e.target.checked)}
            />
            <span>Also delete the worktree directory on disk</span>
          </label>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            data-testid="archive-cancel"
            onClick={onCancel}
            style={{
              background: "#313244",
              color: "#a6adc8",
              border: "none",
              borderRadius: 4,
              padding: "6px 14px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            data-testid="archive-confirm"
            onClick={() => onConfirm(isWorktree && deleteWorktree)}
            style={{
              background: "#45475a",
              color: "#f9e2af",
              border: "none",
              borderRadius: 4,
              padding: "6px 16px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Archive
          </button>
        </div>
      </div>
    </div>
  );
}
