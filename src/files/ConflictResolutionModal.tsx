import { useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { ConflictDiffView } from "./ConflictDiffView";

export interface ConflictResolutionModalProps {
  open: boolean;
  fileName: string;
  diskContent: string;
  mineContent: string;
  language?: string;
  onKeepMine: () => void;
  onTakeDisk: () => void;
  onCancel: () => void;
}

const buttonStyle = {
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "8px 14px",
};

export function ConflictResolutionModal({
  open,
  fileName,
  diskContent,
  mineContent,
  language,
  onKeepMine,
  onTakeDisk,
  onCancel,
}: ConflictResolutionModalProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    cancelButtonRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const title = `${fileName} changed on disk`;

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      data-testid="conflict-resolution-modal"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-resolution-title"
        data-testid="conflict-resolution-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        style={{
          background: "#1e1e2e",
          color: "#cdd6f4",
          border: "1px solid #313244",
          borderRadius: 8,
          width: "min(1100px, 96vw)",
          maxHeight: "90vh",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        <div
          style={{
            padding: "14px 18px 12px",
            borderBottom: "1px solid #313244",
          }}
        >
          <div id="conflict-resolution-title" style={{ color: "#89b4fa", fontSize: 14 }}>
            {title}
          </div>
          <div style={{ color: "#a6adc8", marginTop: 6 }}>
            This file was modified outside the editor while you were editing. Pick how to resolve:
          </div>
        </div>

        <div style={{ padding: 14, minHeight: 240, overflow: "hidden" }}>
          <ConflictDiffView
            diskContent={diskContent}
            mineContent={mineContent}
            language={language}
            style={{
              height: "min(60vh, 620px)",
              minHeight: 240,
              border: "1px solid #313244",
              borderRadius: 4,
              overflow: "hidden",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 14px 14px",
            borderTop: "1px solid #313244",
          }}
        >
          <button
            ref={cancelButtonRef}
            onClick={onCancel}
            style={{
              ...buttonStyle,
              background: "#313244",
              color: "#a6adc8",
            }}
          >
            Cancel
          </button>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={onTakeDisk}
              style={{
                ...buttonStyle,
                background: "#45475a",
                color: "#cdd6f4",
              }}
            >
              Take disk version
            </button>
            <button
              onClick={onKeepMine}
              aria-label="Keep my version and overwrite disk on next save"
              title="Overwrites the disk file on next save and discards external changes"
              style={{
                ...buttonStyle,
                background: "#f9e2af",
                color: "#1e1e2e",
                fontWeight: 700,
              }}
            >
              Keep my version — overwrite disk on next save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
