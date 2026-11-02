import { useState } from "react";
import {
  addChange,
  isOrphanHidden,
  ktloStoryDraft,
  linkTargets,
  nextSprint,
  ORPHAN_RANGES,
  sprintsFromCurrent,
  unlinkPr,
  visibleOrphans,
  type Change,
  type KtloFeature,
  type OrphanPr,
  type OrphanReport,
  type PlanningData,
  type PrRef,
} from "../domain/planning";
import { button, C, card, input, label, primary } from "./styles";

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
  ktlo?: KtloFeature | null;
  ktloError?: string | null;
  onSetKtlo?: (link: string) => Promise<void>;
}

const NEW_KTLO = "new-ktlo";

/** This semester's KTLO feature: a prompt to set it, or its title with Change. */
function KtloLine({ ktlo, error, onSet }: { ktlo: KtloFeature | null; error: string | null; onSet: (link: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const save = () => {
    if (!link.trim()) return;
    setBusy(true);
    setRefusal(null);
    void onSet(link.trim())
      .then(() => { setEditing(false); setLink(""); })
      .catch((failure) => setRefusal(String(failure instanceof Error ? failure.message : failure)))
      .finally(() => setBusy(false));
  };
  const asking = editing || !ktlo;
  return (
    <div data-testid="planning-ktlo" style={{ ...card, display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
        <span style={{ color: C.sub, flex: asking ? undefined : 1, minWidth: 0 }}>
          KTLO feature:{" "}
          {ktlo
            ? <><a href={ktlo.url} target="_blank" rel="noreferrer" style={{ color: C.text, fontWeight: 600 }}>{ktlo.title}</a> <span style={{ color: C.muted }}>#{ktlo.id}</span></>
            : <span style={{ color: C.muted }}>Set the KTLO feature — paste this semester's feature link</span>}
        </span>
        {asking ? (
          <>
            <input data-testid="planning-ktlo-input" aria-label="KTLO feature link" value={link} placeholder="https://…/_workitems/edit/<id>"
              onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape" && ktlo) setEditing(false); }}
              style={{ ...input, flex: 1, minWidth: 0 }} />
            <button data-testid="planning-ktlo-set" disabled={busy || !link.trim()} onClick={save} style={primary}>Set</button>
            {ktlo && <button onClick={() => { setEditing(false); setRefusal(null); }} style={button}>Cancel</button>}
          </>
        ) : (
          <button data-testid="planning-ktlo-change" onClick={() => setEditing(true)} style={button}>Change</button>
        )}
      </div>
      {ktlo?.problem && <span data-testid="planning-ktlo-problem" style={{ color: C.red }}>{ktlo.problem}</span>}
      {(refusal || error) && <span data-testid="planning-ktlo-error" role="alert" style={{ color: C.red }}>{refusal ?? error}</span>}
    </div>
  );
}

/** The new KTLO story's name, points and sprint, under the PR's row. */
function KtloForm({ pr, ktlo, data, onAdd, onCancel }: {
  pr: OrphanPr; ktlo: KtloFeature; data: PlanningData;
  onAdd: (story: { title: string; points: number | null; iteration: string }) => void; onCancel: () => void;
}) {
  const sprints = sprintsFromCurrent(data);
  const [title, setTitle] = useState(pr.title);
  const [points, setPoints] = useState("1");
  const [iteration, setIteration] = useState(nextSprint(data)?.path ?? sprints[0]?.path ?? "");
  const parsed = points.trim() === "" ? null : Number(points);
  const valid = title.trim() !== "" && iteration !== "" && (parsed === null || (Number.isFinite(parsed) && parsed >= 0));
  const row = { display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center" } as const;
  return (
    <div data-testid={`planning-ktlo-form-${pr.id}`} style={{ display: "grid", gap: 6, marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${C.surface1}` }}>
      <div style={row}><span style={{ color: C.sub }}>Feature</span><span>{ktlo.title} <span style={{ color: C.muted }}>#{ktlo.id}</span></span></div>
      <label style={row}><span style={{ color: C.sub }}>Name</span>
        <input data-testid="planning-ktlo-name" value={title} onChange={(e) => setTitle(e.target.value)} style={input} /></label>
      <label style={row}><span style={{ color: C.sub }}>Story points</span>
        <input data-testid="planning-ktlo-points" type="number" min={0} step="any" value={points} onChange={(e) => setPoints(e.target.value)} style={{ ...input, width: 70 }} /></label>
      <label style={row}><span style={{ color: C.sub }}>Sprint</span>
        <select data-testid="planning-ktlo-sprint" value={iteration} onChange={(e) => setIteration(e.target.value)} style={input}>
          {sprints.map((i) => <option key={i.path} value={i.path}>{i.name}{i.timeframe === "current" ? " (current in ADO)" : ""}</option>)}
        </select></label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: 98 }}>
        <button data-testid="planning-ktlo-add" disabled={!valid} onClick={() => onAdd({ title: title.trim(), points: parsed, iteration })} style={primary}>Add to draft</button>
        <button data-testid="planning-ktlo-cancel" onClick={onCancel} style={button}>Cancel</button>
        <span style={{ color: C.muted, fontSize: 11 }}>Created in ADO when you publish.</span>
      </div>
    </div>
  );
}

const STATE_COLOR: Record<string, string> = { active: C.blue, draft: C.muted, completed: C.green };

/**
 * Your PRs from the last 7 / 30 / 90 days, across Planning's organization,
 * that have no linked work item. Hide PRs or repos you don't care about, or
 * link a PR to one of your stories (or a sprint story's task) through the draft.
 */
export function OrphansTab({ data, report, error, draft, onAddChange, onSetDraft, onDays, onHide, onUnhide, ktlo = null, ktloError = null, onSetKtlo }: Props) {
  const [showHidden, setShowHidden] = useState(false);
  const [formFor, setFormFor] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => {
    setActionError(null);
    void action().catch((failure) => setActionError(String(failure instanceof Error ? failure.message : failure)));
  };
  if (!report) return <p data-testid="planning-orphans" style={{ color: error ? C.red : C.sub }}>{error ?? "Loading your PRs…"}</p>;

  const targets = linkTargets(data, draft);
  const ktloUsable = !!ktlo && !ktlo.problem;
  const ktloUnavailable = !ktlo ? "set the KTLO feature first" : ktlo.problem ? `KTLO feature is ${ktlo.state}` : null;
  const prRef = (pr: OrphanPr): PrRef => ({ id: pr.id, project_id: pr.project_id, repo_id: pr.repo_id, title: pr.title });
  const pendingFor = (pr: OrphanPr) => draft.find((c): c is Extract<Change, { kind: "link_pr" }> => c.kind === "link_pr" && c.pr.id === pr.id);
  const link = (pr: OrphanPr, value: string) => {
    if (value === NEW_KTLO) { setFormFor(pr.id); return; }
    setFormFor(null);
    // The PR's current target again: nothing changes.
    if (value && value === String(pendingFor(pr)?.id ?? "")) return;
    run(async () => {
      if (!value) {
        await onSetDraft(unlinkPr(draft, pr.id));
        return;
      }
      const target = targets.find((t) => String(t.id) === value);
      if (!target) return;
      const change: Change = { kind: "link_pr", id: target.id, rev: target.rev, pr: prRef(pr) };
      // Moving the PR a drafted story was made for drops that story first.
      const base = unlinkPr(draft, pr.id);
      const ownsStory = base.length < draft.length - 1;
      if (ownsStory) await onSetDraft(addChange(base, change));
      else await onAddChange(change);
    });
  };
  const addKtloStory = (pr: OrphanPr, story: { title: string; points: number | null; iteration: string }) => {
    if (!ktlo) return;
    run(async () => {
      await onSetDraft(ktloStoryDraft(unlinkPr(draft, pr.id), ktlo.id, prRef(pr), story));
      setFormFor(null);
    });
  };
  const shown = visibleOrphans(report);
  const hiddenCount = report.hidden.prs.length + report.hidden.repos.length;
  const sprintName = (path: string | null | undefined) => data.iterations.find((i) => i.path === path)?.name ?? path ?? "";
  const pendingText = (pending: Extract<Change, { kind: "link_pr" }>) => {
    const story = draft.find((c): c is Extract<Change, { kind: "create_story" }> => c.kind === "create_story" && c.temp_id === pending.id);
    const first = draft.find((c) => c.kind === "link_pr" && c.id === pending.id);
    if (story && first === pending) return `New KTLO story “${story.title}” (${story.points ?? "?"} pt, ${sprintName(story.iteration)})`;
    return targets.find((t) => t.id === pending.id)?.title ?? `#${pending.id}`;
  };

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
      {onSetKtlo && <KtloLine ktlo={ktlo} error={ktloError} onSet={onSetKtlo} />}
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
          <div key={pr.id} data-testid={`planning-orphan-row-${pr.id}`} style={{ ...card, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <a href={pr.url} target="_blank" rel="noreferrer" style={{ color: C.text, textDecoration: "none", overflowWrap: "anywhere" }}>{pr.title}</a>
              <div style={{ ...label, textTransform: "none", letterSpacing: 0, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span>{pr.repo}</span>
                <span>· {pr.created.slice(0, 10)}</span>
                {pending && (
                  <span data-testid={`planning-orphan-pending-${pr.id}`} style={{ color: C.peach }}>
                    ● → {pendingText(pending)}, not published
                  </span>
                )}
              </div>
            </div>
            <span style={{ fontSize: 10, border: `1px solid ${STATE_COLOR[pr.state] ?? C.muted}`, color: STATE_COLOR[pr.state] ?? C.muted, borderRadius: 8, padding: "0 6px" }}>{pr.state}</span>
            <select
              data-testid={`planning-orphan-link-${pr.id}`}
              aria-label={`Link ${pr.title} to`}
              value={formFor === pr.id ? NEW_KTLO : pending ? String(pending.id) : ""}
              onChange={(e) => link(pr, e.target.value)}
              style={{ ...input, maxWidth: 200, fontSize: 11 }}
            >
              <option value="">Link to…</option>
              {onSetKtlo && (
                <option value={NEW_KTLO} disabled={!ktloUsable}>
                  ＋ New KTLO story…{ktloUnavailable ? ` (${ktloUnavailable})` : ""}
                </option>
              )}
              {targets.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.drafted ? `New: ${t.title} (not published)` : t.task ? `— ${t.title}` : t.title}
                </option>
              ))}
            </select>
            <button data-testid={`planning-orphan-hide-${pr.id}`} title="Hide this PR" onClick={() => run(() => onHide("pr", String(pr.id), pr.title))} style={button}>Hide</button>
            <button data-testid={`planning-orphan-hide-repo-${pr.id}`} title={`Hide every PR in ${pr.repo}`} onClick={() => run(() => onHide("repo", pr.repo_id, pr.repo))} style={button}>Hide repo</button>
          </div>
          {formFor === pr.id && ktlo && ktloUsable && (
            <KtloForm pr={pr} ktlo={ktlo} data={data} onAdd={(story) => addKtloStory(pr, story)} onCancel={() => setFormFor(null)} />
          )}
          </div>
        );
      })}
    </div>
  );
}
