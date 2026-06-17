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
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e2e",
          border: "1px solid #45475a",
          borderRadius: 6,
          padding: 20,
          minWidth: 320,
          maxWidth: 480,
          color: "#cdd6f4",
          boxShadow: "0 6px 30px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Archive &ldquo;{workstreamName}&rdquo;?
        </div>
        <div style={{ fontSize: 12, color: "#a6adc8", marginBottom: 16 }}>
          It will move to the archived section and its tiles will be closed.
          Running processes will be stopped; state is preserved.
        </div>

        {isWorktree && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#a6adc8", marginBottom: 16 }}>
            <input
              data-testid="archive-delete-worktree"
              type="checkbox"
              checked={deleteWorktree}
              onChange={(e) => setDeleteWorktree(e.target.checked)}
            />
            Also delete the worktree directory on disk
          </label>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            data-testid="archive-cancel"
            onClick={onCancel}
            style={{
              background: "transparent",
              border: "1px solid #45475a",
              color: "#cdd6f4",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            data-testid="archive-confirm"
            onClick={() => onConfirm(isWorktree && deleteWorktree)}
            autoFocus
            style={{
              background: "#f38ba8",
              border: "1px solid #f38ba8",
              color: "#1e1e2e",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Archive
          </button>
        </div>
      </div>
    </div>
  );
}
