import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { PrInboxSnapshot } from "../domain/pr-inbox";

interface Props {
  snapshot: PrInboxSnapshot;
  loading: boolean;
  error: string | null;
  onRead: (id: string, isRead: boolean) => Promise<void>;
  onClose: () => void;
}

export function PrInboxModal({ snapshot, loading, error, onRead, onClose }: Props) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try { await action(); }
    catch (failure) { setActionError(String(failure instanceof Error ? failure.message : failure)); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <section role="dialog" aria-modal="true" aria-label="PR inbox" onClick={(event) => event.stopPropagation()}
        style={{ width: "min(820px,92vw)", maxHeight: "82vh", overflowY: "auto", background: "#1e1e2e", color: "#cdd6f4", border: "1px solid #45475a", borderRadius: 8, padding: 20 }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>PR inbox</h2>
          <button aria-label="Close inbox" onClick={onClose} style={buttonStyle}><XMarkIcon width={18} height={18} /></button>
        </header>
        <p style={{ color: "#a6adc8", fontSize: 12 }}>
          Direct ADO review assignments. Enable notifications in Repos. Checks every two minutes while Workstreams is open.
          The first check is silent; drafts appear only when ready for review.
        </p>
        {loading && <p role="status">Loading inbox...</p>}
        {(error || actionError) && <p role="alert" style={{ color: "#f38ba8" }}>{actionError ?? error}</p>}
        {!loading && !error && snapshot.items.length === 0 && <p>No review notifications yet.</p>}
        {snapshot.repos.map((repo) => (
          <section key={repo.project_id} style={{ borderTop: "1px solid #313244", padding: "12px 0" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 13 }}>{repo.repo_name}</h3>
            <div style={{ color: "#a6adc8", fontSize: 11 }}>
              {!repo.enabled ? "Notifications off" : repo.last_checked ? `Last checked: ${new Date(repo.last_checked).toLocaleString()}` : "Waiting for first successful check"}
            </div>
            {repo.enabled && repo.error && <p role="alert" style={{ color: "#f38ba8", fontSize: 12 }}>{repo.error}</p>}
            {snapshot.items.filter((item) => item.project_id === repo.project_id).map((item) => (
              <article key={item.id} data-testid={`pr-notification-${item.id}`} data-read={item.is_read}
                style={{ display: "flex", gap: 12, alignItems: "center", borderLeft: `3px solid ${item.is_read ? "#45475a" : "#89b4fa"}`, padding: "10px 12px", marginTop: 8, background: "#181825" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <button disabled={busy} onClick={() => void act(async () => { await openUrl(item.url); await onRead(item.id, true); })}
                    style={{ ...buttonStyle, border: "none", padding: 0, textAlign: "left", color: "#89b4fa", fontWeight: item.is_read ? 400 : 600, overflowWrap: "anywhere" }}>
                    #{item.pr_id} {item.title}
                    <ArrowTopRightOnSquareIcon aria-hidden="true" width={13} height={13} style={{ display: "inline", marginLeft: 6 }} />
                  </button>
                  <div style={{ color: "#a6adc8", fontSize: 11, marginTop: 4 }}>
                    {item.author} | {new Date(item.discovered_at).toLocaleString()} | {item.is_read ? "Read" : "Unread"}
                  </div>
                </div>
                <button disabled={busy} onClick={() => void act(() => onRead(item.id, !item.is_read))} style={buttonStyle}>
                  {item.is_read ? "Mark unread" : "Mark read"}
                </button>
              </article>
            ))}
          </section>
        ))}
      </section>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "transparent", border: "1px solid #45475a", color: "#cdd6f4",
  borderRadius: 4, cursor: "pointer", padding: "5px 9px", fontSize: 12,
};
