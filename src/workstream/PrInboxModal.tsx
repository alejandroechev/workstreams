import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon, BellSlashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  describeMute,
  groupPrInboxItems,
  PR_EVENT_LABELS,
  PR_WATCH_MODE_LABELS,
  type PrEventKind,
  type PrInboxSnapshot,
} from "../domain/pr-inbox";
import { groupPipelineItems, resultLabel, type PipelineItem } from "../domain/pipeline-inbox";
import { resultColor } from "./pipeline-result";

import type { SyncEvent } from "../domain/sync-monitor";
type Kind = "all" | "prs" | "pipelines" | "sync";

interface Props {
  snapshot: PrInboxSnapshot;
  loading: boolean;
  error: string | null;
  onRead: (id: string, isRead: boolean) => Promise<void>;
  /** Stop tracking events like this one, in every repo (ADR 036). */
  onMute?: (id: string) => Promise<void>;
  onResetMutes?: () => Promise<unknown>;
  /** Opens the Pipelines manager (ADR 038). */
  onOpenPipelines?: () => void;
  /** Sync server alerts (ADR 040), newest first. */
  syncEvents?: SyncEvent[];
  onSyncRead?: (id: string, isRead: boolean) => Promise<void>;
  onClose: () => void;
}

/**
 * The Inbox: pull request activity (ADR 030/031) and pipeline runs (ADR 038),
 * each in its own section, with one unread count.
 *
 * Chrome deliberately mirrors `RepoManagerModal`: same backdrop, panel border,
 * header/subtitle pair, toolbar note and 12/11px type scale. The inbox is
 * reached from the same sidebar footer, so a different shell read as a
 * different app.
 */
export function PrInboxModal({ snapshot, loading, error, onRead, onMute, onResetMutes, onOpenPipelines, syncEvents = [], onSyncRead, onClose }: Props) {
  const [kind, setKind] = useState<Kind>("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [showMutes, setShowMutes] = useState(false);
  const mutes = snapshot.mutes ?? [];
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

  const runs = snapshot.pipeline_items ?? [];
  const total = snapshot.items.length + runs.length + syncEvents.length;
  const unread = snapshot.items.filter((item) => !item.is_read).length + runs.filter((item) => !item.is_read).length
    + syncEvents.filter((e) => !e.is_read).length;
  const visible = showRead ? snapshot.items : snapshot.items.filter((item) => !item.is_read);
  const visibleRuns = showRead ? runs : runs.filter((item) => !item.is_read);
  const visibleSync = showRead ? syncEvents : syncEvents.filter((e) => !e.is_read);
  const shows = (section: Kind) => kind === "all" || kind === section;
  const pipelineGroups = groupPipelineItems(visibleRuns);
  // What the current filters show, and what they hide because it was read.
  const shownCount = (shows("prs") ? visible.length : 0) + (shows("pipelines") ? visibleRuns.length : 0) + (shows("sync") ? visibleSync.length : 0);
  const inKind = (shows("prs") ? snapshot.items.length : 0) + (shows("pipelines") ? runs.length : 0) + (shows("sync") ? syncEvents.length : 0);
  const failedChecks = (snapshot.pipelines ?? []).filter((pipeline) => pipeline.error);
  const openRun = (run: PipelineItem) => act(async () => {
    await openUrl(run.url);
    if (!run.is_read) await onRead(run.id, true);
  });

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
        aria-label="Inbox"
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
            <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 13 }}>Inbox</div>
            <div data-testid="pr-inbox-summary" style={{ color: "#6c7086", fontSize: 11 }}>
              {unread} unread of {total} notification{total === 1 ? "" : "s"}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          {onOpenPipelines && (
            <button data-testid="inbox-pipelines-open" onClick={onOpenPipelines} title="Choose which pipelines notify" style={{ ...buttonStyle, marginRight: 8 }}>
              Pipelines…
            </button>
          )}
          <button aria-label="Close inbox" data-testid="pr-inbox-close" onClick={onClose} title="Close" style={iconButtonStyle}>
            <XMarkIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={{ ...noteStyle, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1 }}>
            ADO activity on the PRs each repo watches (choose in Repos) and runs of the pipelines you
            watch (choose in Pipelines). Checks every two minutes while Workstreams is open; nothing that
            happened before you started watching is reported.
          </span>
          <div role="group" aria-label="Show kind" style={{ display: "flex" }}>
            {([["All", "all"], ["Pull requests", "prs"], ["Pipelines", "pipelines"], ["Sync server", "sync"]] as const).map(([label, value], index, all) => (
              <button
                key={value}
                aria-pressed={kind === value}
                data-testid={`inbox-kind-${value}`}
                onClick={() => setKind(value)}
                style={{
                  ...buttonStyle,
                  padding: "2px 10px",
                  borderRadius: index === 0 ? "4px 0 0 4px" : index === all.length - 1 ? "0 4px 4px 0" : 0,
                  marginLeft: index === 0 ? 0 : -1,
                  background: kind === value ? "#313244" : "#181825",
                  color: kind === value ? "#cdd6f4" : "#6c7086",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {onResetMutes && mutes.length > 0 && (
            <button
              aria-expanded={showMutes}
              data-testid="pr-inbox-muted-toggle"
              onClick={() => setShowMutes(!showMutes)}
              title="Events you stopped tracking, in every repo"
              style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <BellSlashIcon aria-hidden="true" width={12} height={12} />
              {`Muted (${mutes.length})`}
            </button>
          )}
          <div role="group" aria-label="Show notifications" style={{ display: "flex" }}>
            {([["Unread", false], ["With read", true]] as const).map(([label, value], index) => (
              <button
                key={label}
                aria-pressed={showRead === value}
                data-testid={`pr-inbox-filter-${value ? "all" : "unread"}`}
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

        {showMutes && onResetMutes && mutes.length > 0 && (
          <div data-testid="pr-inbox-mutes" style={{ ...noteStyle, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1 }}>Not tracked in any repo. New events like these are skipped; existing ones were marked read.</span>
              <button
                disabled={busy}
                onClick={() => void act(async () => { await onResetMutes(); setShowMutes(false); })}
                style={buttonStyle}
              >
                Reset all
              </button>
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
              {mutes.map((rule) => (
                <li key={`${rule.kind}\u0000${rule.subject}\u0000${rule.outcome}`} style={{ color: "#a6adc8" }}>
                  <span style={kindStyle(rule.kind)}>{PR_EVENT_LABELS[rule.kind] ?? rule.kind}</span>{" "}
                  {describeMute(rule)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {loading && <p role="status" style={emptyStyle}>Loading inbox...</p>}
          {(error || actionError) && (
            <p role="alert" style={{ ...emptyStyle, color: "#f38ba8", textAlign: "left" }}>{actionError ?? error}</p>
          )}
          {!loading && !error && total === 0 && <p style={emptyStyle}>No notifications yet.</p>}
          {!loading && !error && !showRead && inKind > 0 && shownCount === 0 && (
            <p data-testid="pr-inbox-caught-up" style={emptyStyle}>
              No unread notifications. {inKind} read hidden.
            </p>
          )}
          {shows("sync") && (kind === "sync" || visibleSync.length > 0) && (
            <section data-testid="inbox-section-sync">
              {kind === "all" && <h2 style={sectionHeadingStyle}>Sync server</h2>}
              {kind === "sync" && syncEvents.length === 0 && (
                <p style={emptyStyle}>No sync server alerts. Open Sync server in the sidebar to see its state.</p>
              )}
              <ul style={{ listStyle: "none", margin: 0, padding: "0 12px", display: "grid", gap: 6 }}>
                {visibleSync.map((e) => (
                  <li
                    key={e.id}
                    data-testid={`sync-event-${e.id}`}
                    data-read={e.is_read}
                    style={{
                      border: "1px solid #313244",
                      borderLeft: `2px solid ${e.is_read ? "#45475a" : e.event === "resolved" ? "#a6e3a1" : "#f38ba8"}`,
                      borderRadius: 4,
                      padding: "8px 10px",
                      marginTop: 8,
                      background: "#181825",
                      fontSize: 11,
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ flex: 1, fontSize: 12, fontWeight: e.is_read ? 400 : 600, color: e.is_read ? "#a6adc8" : "#cdd6f4" }}>{e.message}</span>
                      <span style={{ color: "#6c7086", whiteSpace: "nowrap" }}>{new Date(e.at).toLocaleString()}</span>
                      {onSyncRead && (
                        <button disabled={busy} aria-label={`${e.is_read ? "Mark unread" : "Read"}: ${e.message}`}
                          onClick={() => void act(() => onSyncRead(e.id, !e.is_read))} style={{ ...buttonStyle, padding: "1px 6px", fontSize: 10 }}>
                          {e.is_read ? "Unread" : "Read"}
                        </button>
                      )}
                    </div>
                    <div data-testid={`sync-event-hint-${e.id}`} style={{ color: "#a6adc8", marginTop: 4 }}>{e.hint}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {shows("prs") && (
          <section data-testid="inbox-section-prs">
          {kind === "all" && <h2 style={sectionHeadingStyle}>Pull requests</h2>}
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
                          {onMute && event.subject && (
                            <button
                              disabled={busy}
                              aria-label={`Stop tracking: ${describeMute(event)}`}
                              title={`Stop tracking: ${describeMute(event)} (every repo)`}
                              onClick={() => void act(() => onMute(event.id))}
                              style={{ ...buttonStyle, padding: "1px 4px", display: "inline-flex", alignItems: "center" }}
                            >
                              <BellSlashIcon aria-hidden="true" width={11} height={11} />
                            </button>
                          )}
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
          </section>
          )}
          {shows("pipelines") && (
            <section data-testid="inbox-section-pipelines">
              {kind === "all" && <h2 style={sectionHeadingStyle}>Pipelines</h2>}
              {failedChecks.map((pipeline) => (
                <p key={pipeline.id} role="alert" data-testid={`pipeline-check-error-${pipeline.id}`} style={{ color: "#f38ba8", fontSize: 11, margin: "6px 12px 0" }}>
                  {pipeline.name}: {pipeline.error}
                </p>
              ))}
              {kind === "pipelines" && runs.length === 0 && (
                <p data-testid="inbox-pipelines-empty" style={emptyStyle}>
                  No pipeline notifications. Choose what notifies in Pipelines.
                </p>
              )}
              {pipelineGroups.map((group) => (
                <article
                  key={group.pipeline_id}
                  data-testid={`pipeline-group-${group.pipeline_id}`}
                  data-unread={group.unread}
                  style={{
                    border: "1px solid #313244",
                    borderLeft: `2px solid ${group.unread ? "#f38ba8" : "#45475a"}`,
                    borderRadius: 4,
                    padding: "8px 10px",
                    margin: "8px 12px 0",
                    background: "#181825",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: group.unread ? 600 : 400, color: "#cdd6f4" }}>
                    {group.pipeline_name} <span style={{ color: "#6c7086", fontWeight: 400, fontSize: 11 }}>{group.project}</span>
                  </div>
                  <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 4 }}>
                    {group.items.map((run) => (
                      <li
                        key={run.id}
                        data-testid={`pipeline-notification-${run.id}`}
                        data-read={run.is_read}
                        style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11 }}
                      >
                        <span style={resultStyle(run.result)}>{resultLabel(run.result)}</span>
                        <button
                          data-testid={`pipeline-open-${run.id}`}
                          disabled={busy}
                          onClick={() => void openRun(run)}
                          title="Open the run in Azure DevOps"
                          style={{
                            flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, textAlign: "left",
                            cursor: "pointer", fontFamily: "inherit", fontSize: 11, overflowWrap: "anywhere",
                            color: run.is_read ? "#6c7086" : "#cdd6f4",
                          }}
                        >
                          #{run.run_number} · {run.branch} · {run.trigger}
                          <ArrowTopRightOnSquareIcon aria-hidden="true" width={11} height={11} style={{ display: "inline", marginLeft: 6 }} />
                        </button>
                        <span style={{ color: "#6c7086", whiteSpace: "nowrap" }}>{new Date(run.finished_at).toLocaleString()}</span>
                        <button
                          disabled={busy}
                          aria-label={`${run.is_read ? "Mark unread" : "Read"}: ${group.pipeline_name} #${run.run_number}`}
                          onClick={() => void act(() => onRead(run.id, !run.is_read))}
                          style={{ ...buttonStyle, padding: "1px 6px", fontSize: 10 }}
                        >
                          {run.is_read ? "Unread" : "Read"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
              <div style={{ height: 10 }} />
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

const sectionHeadingStyle: React.CSSProperties = {
  margin: "10px 12px 0",
  fontSize: 10,
  fontWeight: 600,
  color: "#6c7086",
  textTransform: "uppercase",
  letterSpacing: 1,
};

function resultStyle(result: string): React.CSSProperties {
  const color = resultColor(result);
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
