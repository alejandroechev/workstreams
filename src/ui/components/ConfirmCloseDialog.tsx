import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

/**
 * Confirm-close dialog shown before the window destroys itself. The user
 * can opt out of the dialog permanently via the "Don't ask again"
 * checkbox; persistence is the caller's responsibility (so this stays a
 * dumb, fully testable component).
 */
export default function ConfirmCloseDialog({ open, onConfirm, onCancel }: Props) {
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    if (!open) setDontAsk(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        onConfirm(dontAsk);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dontAsk, onConfirm, onCancel]);

  if (!open) return null;

  return (
    <div
      data-testid="confirm-close-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-close-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div style={{
        background: "#1e1e2e",
        border: "1px solid #45475a",
        borderRadius: 6,
        padding: 20,
        minWidth: 320,
        maxWidth: 480,
        color: "#cdd6f4",
        boxShadow: "0 6px 30px rgba(0,0,0,0.6)",
      }}>
        <div id="confirm-close-title" style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Close Workstreams?
        </div>
        <div style={{ fontSize: 12, color: "#a6adc8", marginBottom: 16 }}>
          Your sessions and layout are persisted, but any running terminals
          will be terminated.
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#a6adc8", marginBottom: 16 }}>
          <input
            type="checkbox"
            data-testid="confirm-close-dont-ask"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
          />
          Don&apos;t ask me again
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            data-testid="confirm-close-cancel"
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
            data-testid="confirm-close-confirm"
            onClick={() => onConfirm(dontAsk)}
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
