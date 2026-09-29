import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  groupPrInboxItems,
  PR_EVENT_LABELS,
  PR_WATCH_MODE_LABELS,
  type PrEventKind,
  type PrInboxSnapshot,
} from "../domain/pr-inbox";

interface Props {
  snapshot: PrInboxSnapshot;
  loading: boolean;
  error: string | null;
  onRead: (id: string, isRead: boolean) => Promise<void>;
  onClose: () => void;
}

/**
 * Chrome deliberately mirrors `RepoManagerModal`: same backdrop, panel border,
 * header/subtitle pair, toolbar note and 12/11px type scale. The inbox is
 * reached from the same sidebar footer, so a different shell read as a
 * different app.
 */
export function PrInboxModal({ snapshot, loading, error, onRead, onClose }: Props) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRead, setShowRead] = useState(false);
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

  const total = snapshot.items.length;
  const unread = snapshot.items.filter((item) => !item.is_read).length;
  const visible = showRead ? snapshot.items : snapshot.items.filter((item) => !item.is_read);

  return (
    <div
      data-testid="pr-inbox-backdrop"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="PR inbox"
        data-testid="pr-inbox-panel"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(820px, 92vw)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          background: "#1e1e2e",
          color: "#cdd6f4",
          border: "1px solid #313244",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <div style={headerStyle}>
          <div>
            <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 13 }}>PR inbox</div>
            <div data-testid="pr-inbox-summary" style={{ color: "#6c7086", fontSize: 11 }}>
              {unread} unread of {total} notification{total === 1 ? "" : "s"}
            </div>
          </div>
          <button aria-label="Close inbox" data-testid="pr-inbox-close" onClick={onClose} title="Close" style={iconButtonStyle}>
            <XMarkIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={{ ...noteStyle, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1 }}>
            ADO activity on the PRs each repo watches. Choose what to watch in Repos. Checks every two
            minutes while Workstreams is open; the first check is silent.
          </span>
          <div role="group" aria-label="Show notifications" style={{ display: "flex" }}>
            {([["Unread", false], ["All", true]] as const).map(([label, value], index) => (
              <button
                key={label}
                aria-pressed={showRead === value}
                data-testid={`pr-inbox-filter-${label.toLowerCase()}`}
                onClick={() => setShowRead(value)}
                style={{
                  ...buttonStyle,
                  padding: "2px 10px",
                  borderRadius: index === 0 ? "4px 0 0 4px" : "0 4px 4px 0",
                  marginLeft: index === 0 ? 0 : -1,
                  background: showRead === value ? "#313244" : "#181825",
                  color: showRead === value ? "#cdd6f4" : "#6c7086",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {loading && <p role="status" style={emptyStyle}>Loading inbox...</p>}
          {(error || actionError) && (
            <p role="alert" style={{ ...emptyStyle, color: "#f38ba8", textAlign: "left" }}>{actionError ?? error}</p>
          )}
          {!loading && !error && total === 0 && <p style={emptyStyle}>No review notifications yet.</p>}
          {!loading && !error && total > 0 && visible.length === 0 && (
            <p data-testid="pr-inbox-caught-up" style={emptyStyle}>
              No unread notifications. {total} read hidden.
            </p>
          )}
          {snapshot.repos.map((repo) => {
            const groups = groupPrInboxItems(
              visible.filter((item) => item.project_id === repo.project_id),
            );
            return (
              <section key={repo.project_id} style={{ borderTop: "1px solid #313244", padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "#cdd6f4" }}>{repo.repo_name}</h3>
                  <span style={{ color: "#6c7086", fontSize: 11 }}>
                    {!repo.enabled
                      ? "Notifications off"
                      : `${PR_WATCH_MODE_LABELS[repo.mode]} · ${repo.last_checked
                          ? `last checked ${new Date(repo.last_checked).toLocaleString()}`
                          : "waiting for first successful check"}`}
                  </span>
                </div>
                {repo.enabled && repo.error && (
                  <p role="alert" style={{ color: "#f38ba8", fontSize: 11, margin: "6px 0 0" }}>{repo.error}</p>
                )}
                {groups.map((group) => (
                  <article
                    key={group.key}
                    data-testid={`pr-group-${group.project_id}-${group.pr_id}`}
                    data-unread={group.unread}
                    style={{
                      border: "1px solid #313244",
                      borderLeft: `2px solid ${group.unread ? "#f38ba8" : "#45475a"}`,
                      borderRadius: 4,
                      padding: "8px 10px",
                      marginTop: 8,
                      background: "#181825",
                    }}
                  >
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <button
                          disabled={busy}
                          onClick={() => void act(async () => {
                            await openUrl(group.url);
                            for (const event of group.events) {
                              if (!event.is_read) await onRead(event.id, true);
                            }
                          })}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            textAlign: "left",
                            cursor: "pointer",
                            fontFamily: "inherit",
                            fontSize: 12,
                            color: "#89b4fa",
                            fontWeight: group.unread ? 600 : 400,
                            overflowWrap: "anywhere",
                          }}
                        >
                          #{group.pr_id} {group.title}
                          <ArrowTopRightOnSquareIcon aria-hidden="true" width={12} height={12} style={{ display: "inline", marginLeft: 6 }} />
                        </button>
                        <div style={{ color: "#6c7086", fontSize: 11, marginTop: 3 }}>{group.author}</div>
                      </div>
                      <button
                        disabled={busy}
                        onClick={() => void act(async () => {
                          const read = !group.unread;
                          for (const event of group.events) {
                            if (event.is_read === read) await onRead(event.id, !read);
                          }
                        })}
                        style={buttonStyle}
                      >
                        {group.unread ? "Mark read" : "Mark unread"}
                      </button>
                    </div>
                    <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 4 }}>
                      {group.events.map((event) => (
                        <li
                          key={event.id}
                          data-testid={`pr-notification-${event.id}`}
                          data-read={event.is_read}
                          style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11 }}
                        >
                          <span style={kindStyle(event.kind)}>{PR_EVENT_LABELS[event.kind] ?? event.kind}</span>
                          <span style={{ flex: 1, minWidth: 0, color: event.is_read ? "#6c7086" : "#cdd6f4", overflowWrap: "anywhere" }}>
                            {event.summary}
                          </span>
                          <span style={{ color: "#6c7086", whiteSpace: "nowrap" }}>
                            {new Date(event.discovered_at).toLocaleString()}
                          </span>
                          <button
                            disabled={busy}
                            aria-label={`${event.is_read ? "Mark unread" : "Mark read"}: ${event.summary}`}
                            onClick={() => void act(() => onRead(event.id, !event.is_read))}
                            style={{ ...buttonStyle, padding: "1px 6px", fontSize: 10 }}
                          >
                            {event.is_read ? "Unread" : "Read"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  borderBottom: "1px solid #313244",
};

const noteStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #313244",
  color: "#a6adc8",
  fontSize: 11,
  lineHeight: 1.5,
};

const emptyStyle: React.CSSProperties = {
  padding: 16,
  margin: 0,
  color: "#a6adc8",
  fontSize: 12,
  textAlign: "center",
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  color: "#cdd6f4",
  background: "#181825",
  border: "1px solid #45475a",
  borderRadius: 4,
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: "inherit",
};

const iconButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#6c7086",
  cursor: "pointer",
  padding: 2,
  display: "flex",
};

/**
 * One colour per event kind, so a wall of rows is scannable: a failed gate and
 * a routine comment should not read the same at a glance.
 */
const KIND_COLORS: Record<PrEventKind, string> = {
  assigned: "#f38ba8",
  comment: "#89b4fa",
  vote: "#a6e3a1",
  policy: "#f9e2af",
  closed: "#6c7086",
};

function kindStyle(kind: PrEventKind): React.CSSProperties {
  const color = KIND_COLORS[kind] ?? "#6c7086";
  return {
    color,
    border: `1px solid ${color}`,
    borderRadius: 999,
    fontSize: 9,
    fontWeight: 700,
    padding: "0 6px",
    whiteSpace: "nowrap",
    minWidth: 64,
    textAlign: "center",
  };
}
