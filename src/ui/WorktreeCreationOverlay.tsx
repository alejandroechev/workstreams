import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface ProgressEvent {
  step: string;
  detail: string;
}

const STEP_LABEL: Record<string, string> = {
  resolving: "Resolving repository…",
  "pulling-base": "Pulling latest base branch…",
  "pulled-base": "Base branch updated",
  "pull-skipped": "Skipping base pull",
  creating: "Creating worktree…",
  created: "Worktree created",
};

interface Props {
  /** When true, the overlay is mounted and listening. Parent controls
   *  lifecycle: flip to true before the long-running operation, back to
   *  false once it resolves (success or error). */
  open: boolean;
  /** Title text — typically "Creating worktree…" or "Setting up workstream…". */
  title: string;
}

/**
 * Full-screen modal blocker shown while a worktree is being created.
 * Subscribes to the `worktree-progress` Tauri event to surface
 * per-step feedback. Pointer events on the rest of the app are blocked
 * (overlay covers everything, no close button — the caller is responsible
 * for unmounting when the operation finishes).
 */
export function WorktreeCreationOverlay({ open, title }: Props) {
  const [steps, setSteps] = useState<ProgressEvent[]>([]);

  useEffect(() => {
    if (!open) {
      setSteps([]);
      return;
    }
    let unlisten: UnlistenFn | undefined;
    listen<ProgressEvent>("worktree-progress", (event) => {
      const incoming = event.payload;
      if (!incoming?.step) return;
      setSteps((prev) => {
        // Dedup: collapse consecutive identical steps so the rapid
        // resolving→creating sequence doesn't double-render.
        if (prev.length > 0 && prev[prev.length - 1].step === incoming.step) {
          return prev;
        }
        return [...prev, incoming];
      });
    })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, [open]);

  if (!open) return null;

  const latest = steps[steps.length - 1];

  return (
    <div
      data-testid="worktree-creation-overlay"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 17, 27, 0.85)",
        backdropFilter: "blur(2px)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 16,
        color: "#cdd6f4",
        fontFamily: "monospace",
      }}
    >
      <div
        aria-label="Working"
        style={{
          width: 36,
          height: 36,
          border: "3px solid #313244",
          borderTopColor: "#89b4fa",
          borderRadius: "50%",
          animation: "ws-spinner 0.9s linear infinite",
        }}
      />
      <div style={{ fontSize: 14, color: "#cdd6f4" }}>{title}</div>
      <div
        style={{
          minWidth: 320,
          maxWidth: 480,
          background: "#1e1e2e",
          border: "1px solid #313244",
          borderRadius: 6,
          padding: "10px 14px",
          fontSize: 12,
        }}
      >
        {steps.length === 0 ? (
          <div style={{ color: "#6c7086", fontStyle: "italic" }}>Starting…</div>
        ) : (
          <ol
            data-testid="worktree-progress-steps"
            style={{ margin: 0, padding: 0, listStyle: "none" }}
          >
            {steps.map((s, i) => {
              const isLast = i === steps.length - 1;
              return (
                <li
                  key={`${s.step}-${i}`}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "2px 0",
                    color: isLast ? "#cdd6f4" : "#6c7086",
                  }}
                >
                  <span style={{ color: isLast ? "#89b4fa" : "#45475a" }}>
                    {isLast ? "▸" : "✓"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>{STEP_LABEL[s.step] ?? s.step}</div>
                    {s.detail && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "#585b70",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={s.detail}
                      >
                        {s.detail}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {latest?.step === "pull-skipped" && (
        <div style={{ fontSize: 11, color: "#f9e2af", maxWidth: 480, textAlign: "center" }}>
          Base pull was skipped (offline, diverged, or no remote). Worktree creation continues normally.
        </div>
      )}
      <style>{`@keyframes ws-spinner { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
