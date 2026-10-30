import { useState } from "react";
import {
  isOrphanHidden,
  linkTargets,
  ORPHAN_RANGES,
  visibleOrphans,
  type Change,
  type OrphanPr,
  type OrphanReport,
  type PlanningData,
} from "../domain/planning";
import { button, C, card, input, label } from "./styles";

interface Props {
  data: PlanningData;
  report: OrphanReport | null;
  error: string | null;
  draft: Change[];
  onAddChange: (change: Change) => Promise<void>;
  onSetDraft: (draft: Change[]) => Promise<void>;
  onDays: (days: number) => Promise<void>;
  onHide: (kind: "pr" | "repo", id: string, label: string) => Promise<void>;
  onUnhide: (kind: "pr" | "repo", id: string) => Promise<void>;
}

const STATE_COLOR: Record<string, string> = { active: C.blue, draft: C.muted, completed: C.green };

/**
 * Your PRs from the last 7 / 30 / 90 days, across Planning's organization,
 * that have no linked work item. Hide PRs or repos you don't care about, or
 * link a PR to one of your stories (or a sprint story's task) through the draft.
 */
export function OrphansTab({ data, report, error, draft, onAddChange, onSetDraft, onDays, onHide, onUnhide }: Props) {
  const [showHidden, setShowHidden] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => {
    setActionError(null);
    void action().catch((failure) => setActionError(String(failure instanceof Error ? failure.message : failure)));
  };
  if (!report) return <p data-testid="planning-orphans" style={{ color: error ? C.red : C.sub }}>{error ?? "Loading your PRs…"}</p>;

  const targets = linkTargets(data);
  const pendingFor = (pr: OrphanPr) => draft.find((c): c is Extract<Change, { kind: "link_pr" }> => c.kind === "link_pr" && c.pr.id === pr.id);
  const link = (pr: OrphanPr, value: string) => run(async () => {
    if (!value) {
      await onSetDraft(draft.filter((c) => !(c.kind === "link_pr" && c.pr.id === pr.id)));
      return;
    }
    const target = targets.find((t) => String(t.id) === value);
    if (!target) return;
    await onAddChange({ kind: "link_pr", id: target.id, rev: target.rev, pr: { id: pr.id, project_id: pr.project_id, repo_id: pr.repo_id, title: pr.title } });
  });
  const shown = visibleOrphans(report);
  const hiddenCount = report.hidden.prs.length + report.hidden.repos.length;
  const titleOf = (id: number) => targets.find((t) => t.id === id)?.title ?? `#${id}`;

  return (
    <div data-testid="planning-orphans" style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1, overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select data-testid="planning-orphan-days" aria-label="Range" value={String(report.days)} onChange={(e) => run(() => onDays(Number(e.target.value)))} style={input}>
          {ORPHAN_RANGES.map((d) => <option key={d} value={String(d)}>Last {d} days</option>)}
        </select>
        <span style={{ color: C.muted, fontSize: 11 }}>Your PRs with no linked work item (abandoned ones left out)</span>
        <span style={{ flex: 1 }} />
        <button data-testid="planning-orphan-show-hidden" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)} style={button}>
          Show hidden ({hiddenCount})
        </button>
      </div>
      {(error || actionError) && <p role="alert" style={{ color: C.red, margin: 0 }}>{actionError ?? error}</p>}
      {showHidden && (
        <div data-testid="planning-orphan-hidden-list" style={{ ...card, display: "grid", gap: 4 }}>
          {hiddenCount === 0 && <span style={{ color: C.sub }}>Nothing hidden.</span>}
          {report.hidden.repos.map((h) => (
            <div key={`repo-${h.id}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ flex: 1 }}>{h.label} <span style={{ color: C.muted }}>(repo)</span></span>
              <button data-testid={`planning-orphan-unhide-repo-${h.id}`} onClick={() => run(() => onUnhide("repo", h.id))} style={button}>Unhide</button>
            </div>
          ))}
          {report.hidden.prs.map((h) => (
            <div key={`pr-${h.id}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ flex: 1 }}>{h.label} <span style={{ color: C.muted }}>(PR {h.id})</span></span>
              <button data-testid={`planning-orphan-unhide-pr-${h.id}`} onClick={() => run(() => onUnhide("pr", h.id))} style={button}>Unhide</button>
            </div>
          ))}
        </div>
      )}
      {shown.length === 0 && (
        <p style={{ color: C.sub }}>
          {report.prs.some((p) => isOrphanHidden(p, report.hidden))
            ? "Every orphaned PR in this range is hidden."
            : `No orphaned PRs — every PR of yours in the last ${report.days} days has a work item.`}
        </p>
      )}
      {shown.map((pr) => {
        const pending = pendingFor(pr);
        return (
          <div key={pr.id} data-testid={`planning-orphan-row-${pr.id}`} style={{ ...card, display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <a href={pr.url} target="_blank" rel="noreferrer" style={{ color: C.text, textDecoration: "none", overflowWrap: "anywhere" }}>{pr.title}</a>
              <div style={{ ...label, textTransform: "none", letterSpacing: 0, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span>{pr.repo}</span>
                <span>· {pr.created.slice(0, 10)}</span>
                {pending && (
                  <span data-testid={`planning-orphan-pending-${pr.id}`} style={{ color: C.peach }}>
                    ● → {titleOf(pending.id)}, not published
                  </span>
                )}
              </div>
            </div>
            <span style={{ fontSize: 10, border: `1px solid ${STATE_COLOR[pr.state] ?? C.muted}`, color: STATE_COLOR[pr.state] ?? C.muted, borderRadius: 8, padding: "0 6px" }}>{pr.state}</span>
            <select
              data-testid={`planning-orphan-link-${pr.id}`}
              aria-label={`Link ${pr.title} to`}
              value={pending ? String(pending.id) : ""}
              onChange={(e) => link(pr, e.target.value)}
              style={{ ...input, maxWidth: 200, fontSize: 11 }}
            >
              <option value="">Link to…</option>
              {targets.map((t) => <option key={t.id} value={String(t.id)}>{t.task ? `— ${t.title}` : t.title}</option>)}
            </select>
            <button data-testid={`planning-orphan-hide-${pr.id}`} title="Hide this PR" onClick={() => run(() => onHide("pr", String(pr.id), pr.title))} style={button}>Hide</button>
            <button data-testid={`planning-orphan-hide-repo-${pr.id}`} title={`Hide every PR in ${pr.repo}`} onClick={() => run(() => onHide("repo", pr.repo_id, pr.repo))} style={button}>Hide repo</button>
          </div>
        );
      })}
    </div>
  );
}
