import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon, BellSlashIcon, ChevronDownIcon, ChevronUpIcon, XMarkIcon } from "@heroicons/react/24/outline";
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
import { groupAgentMessages, levelLabel, previewLines, type AgentMessage } from "../domain/agent-messages";
import { MarkdownView } from "../ui/MarkdownView";

import type { SyncEvent } from "../domain/sync-monitor";
type Kind = "all" | "agents" | "prs" | "pipelines" | "sync";

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
  /** Starts investigating a failed run in a new workstream (by notification id). */
  onInvestigate?: (itemId: string) => Promise<void>;
  /** Goes to the session that sent an agent message (ADR 041). */
  onOpenAgentMessage?: (message: AgentMessage) => void;
  /** Switches to a workstream, e.g. a run's existing investigation. */
  onOpenWorkstream?: (workstreamId: string) => void;
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
export function PrInboxModal({ snapshot, loading, error, onRead, onMute, onResetMutes, onOpenPipelines, syncEvents = [], onSyncRead, onInvestigate, onOpenWorkstream, onOpenAgentMessage, onClose }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
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

  const investigate = async (itemId: string) => {
    if (!onInvestigate) return;
    setStarting((current) => new Set(current).add(itemId));
    setActionError(null);
    try { await onInvestigate(itemId); }
    catch (failure) { setActionError(String(failure instanceof Error ? failure.message : failure)); }
    finally {
      setStarting((current) => { const next = new Set(current); next.delete(itemId); return next; });
    }
  };

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try { await action(); }
    catch (failure) { setActionError(String(failure instanceof Error ? failure.message : failure)); }
    finally { setBusy(false); }
  };

  const runs = snapshot.pipeline_items ?? [];
  const messages = snapshot.agent_messages ?? [];
  const total = snapshot.items.length + runs.length + syncEvents.length + messages.length;
  const unread = snapshot.items.filter((item) => !item.is_read).length + runs.filter((item) => !item.is_read).length
    + syncEvents.filter((e) => !e.is_read).length + messages.filter((m) => !m.is_read).length;
  const visibleMessages = showRead ? messages : messages.filter((m) => !m.is_read);
  const visible = showRead ? snapshot.items : snapshot.items.filter((item) => !item.is_read);
  const visibleRuns = showRead ? runs : runs.filter((item) => !item.is_read);
  const visibleSync = showRead ? syncEvents : syncEvents.filter((e) => !e.is_read);
  const shows = (section: Kind) => kind === "all" || kind === section;
  const pipelineGroups = groupPipelineItems(visibleRuns);
  // What the current filters show, and what they hide because it was read.
  const shownCount = (shows("prs") ? visible.length : 0) + (shows("pipelines") ? visibleRuns.length : 0) + (shows("sync") ? visibleSync.length : 0)
    + (shows("agents") ? visibleMessages.length : 0);
  const inKind = (shows("prs") ? snapshot.items.length : 0) + (shows("pipelines") ? runs.length : 0) + (shows("sync") ? syncEvents.length : 0)
    + (shows("agents") ? messages.length : 0);
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
          <div role="group" aria-label="Show kind" style={{ display: "flex", marginRight: "auto" }}>
            {([["All", "all"], ["Agents", "agents"], ["Pull requests", "prs"], ["Pipelines", "pipelines"], ["Sync server", "sync"]] as const).map(([label, value], index, all) => (
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
          {shows("agents") && (kind === "agents" || visibleMessages.length > 0) && (
            <section data-testid="inbox-section-agents">
              {kind === "all" && <h2 style={sectionHeadingStyle}>Agent messages</h2>}
              {kind === "agents" && visibleMessages.length === 0 && (
                <p style={emptyStyle}>No agent messages. Ask a Copilot session to /ws-message you when something happens.</p>
              )}
              {groupAgentMessages(visibleMessages).map((group) => (
                <article
                  key={group.workstream_id}
                  data-testid={`agent-group-${group.workstream_id}`}
                  style={{ border: "1px solid #313244", borderRadius: 6, padding: "8px 10px", margin: "8px 12px 0", background: "#181825" }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#cdd6f4" }}>{group.workstream_name || "Workstream"}</div>
                  <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 6 }}>
                    {group.messages.map((message) => {
                      const open = expanded.has(message.id);
                      return (
                        <li key={message.id} data-testid={`agent-message-${message.id}`} data-read={message.is_read} style={{ fontSize: 11 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                            <span style={{ color: levelColor(message.level), fontWeight: 600, whiteSpace: "nowrap" }}>{levelLabel(message.level)}</span>
                            <button
                              data-testid={`agent-message-open-${message.id}`}
                              disabled={!message.available || !onOpenAgentMessage}
                              onClick={() => onOpenAgentMessage?.(message)}
                              title={message.available ? "Go to the session that sent this" : "The workstream no longer exists"}
                              style={{
                                flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, textAlign: "left",
                                cursor: message.available ? "pointer" : "default", fontFamily: "inherit", fontSize: 11,
                                color: message.is_read ? "#6c7086" : "#cdd6f4", opacity: message.available ? 1 : 0.6,
                              }}
                            >
                              <div style={{ fontWeight: message.is_read ? 400 : 600, overflowWrap: "anywhere" }}>{message.title}</div>
                              {!open && previewLines(message.body).map((line, index) => (
                                <div key={index} data-testid="agent-message-preview-line"
                                  style={{ color: "#a6adc8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{line}</div>
                              ))}
                              {!message.available && (
                                <div data-testid={`agent-message-gone-${message.id}`} style={{ color: "#6c7086" }}>The workstream no longer exists</div>
                              )}
                            </button>
                            <span style={{ color: "#6c7086", whiteSpace: "nowrap" }}>{new Date(message.created_at).toLocaleString()}</span>
                            {message.body.trim() && (
                              <button
                                data-testid={`agent-message-expand-${message.id}`}
                                aria-expanded={open}
                                aria-label={open ? `Collapse: ${message.title}` : `Show all of: ${message.title}`}
                                title={open ? "Collapse" : "Show the whole message"}
                                onClick={() => toggleExpanded(message.id)}
                                style={{ ...buttonStyle, padding: "1px 4px", display: "inline-flex" }}
                              >
                                {open ? <ChevronUpIcon width={12} height={12} /> : <ChevronDownIcon width={12} height={12} />}
                              </button>
                            )}
                            <button
                              disabled={busy}
                              aria-label={`${message.is_read ? "Mark unread" : "Read"}: ${message.title}`}
                              onClick={() => void act(() => onRead(message.id, !message.is_read))}
                              style={{ ...buttonStyle, padding: "1px 6px", fontSize: 10 }}
                            >
                              {message.is_read ? "Unread" : "Read"}
                            </button>
                          </div>
                          {open && (
                            <div data-testid={`agent-message-body-${message.id}`} style={{ margin: "6px 0 0", padding: "6px 8px", background: "#11111b", borderRadius: 4 }}>
                              <MarkdownView baseFontSize={12}>{message.body}</MarkdownView>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </article>
              ))}
              <div style={{ height: 10 }} />
            </section>
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
                    {group.items[0]?.repo && (
                      <span data-testid={`pipeline-group-repo-${group.pipeline_id}`} style={{ color: "#a6adc8", fontWeight: 400, fontSize: 11 }}> · {group.items[0].repo}</span>
                    )}
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
                        {run.result === "failed" && (run.investigation ? onOpenWorkstream : onInvestigate) && (
                          <button
                            data-testid={`pipeline-investigate-${run.id}`}
                            disabled={starting.has(run.id)}
                            title={run.investigation ? "Switch to this run's investigation workstream" : "Start a Copilot session that investigates this failure, in a new workstream"}
                            onClick={() => {
                              if (run.investigation) onOpenWorkstream?.(run.investigation);
                              else void investigate(run.id);
                            }}
                            style={{ ...buttonStyle, padding: "1px 6px", fontSize: 10, whiteSpace: "nowrap" }}
                          >
                            {starting.has(run.id) ? "Starting…" : run.investigation ? "Open investigation" : "Investigate"}
                          </button>
                        )}
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

function levelColor(level: string): string {
  return { done: "#a6e3a1", "needs-you": "#fab387", error: "#f38ba8" }[level] ?? "#89b4fa";
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
