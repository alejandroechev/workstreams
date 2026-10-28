import { useEffect, useState } from "react";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { applyDraft, describeChange, draftLabel, endedSprintOffer } from "../domain/planning";
import type { Planning } from "./usePlanning";
import { SprintTab } from "./SprintTab";
import { FeaturesTab } from "./FeaturesTab";
import { PlanSprintTab } from "./PlanSprintTab";
import { PlanFeatureTab } from "./PlanFeatureTab";
import { button, C, input, primary } from "./styles";

type Tab = "sprint" | "features" | "plan-sprint" | "plan-feature";
const TABS: Array<[Tab, string]> = [["sprint", "Sprint"], ["features", "Features"], ["plan-sprint", "Plan sprint"], ["plan-feature", "Plan feature"]];

interface Props {
  planning: Planning;
  onClose: () => void;
  /** Injected for tests; the real clock otherwise. */
  now?: () => Date;
}

const message = (failure: unknown) => String(failure instanceof Error ? failure.message : failure);

/**
 * Your ADO sprint and features, and planning them (ADR 039). Planning
 * changes collect in a draft and only reach ADO when you publish them.
 */
export function PlanningView({ planning, onClose, now = () => new Date() }: Props) {
  const { connection, data, draft, error, loading, lastPublish } = planning;
  const [tab, setTab] = useState<Tab>("sprint");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDraft, setShowDraft] = useState(false);
  const [published, setPublished] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try { await action(); } catch (failure) { setActionError(message(failure)); } finally { setBusy(false); }
  };

  const items = data ? applyDraft(data, draft) : [];
  const offer = data ? endedSprintOffer(data, now()) : null;

  return (
    <div data-testid="planning-view" role="dialog" aria-label="Planning" style={{ position: "fixed", inset: 0, background: C.base, color: C.text, zIndex: 1900, display: "flex", flexDirection: "column", fontSize: 12 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${C.surface0}` }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Planning</span>
        {connection && <span data-testid="planning-team" style={{ color: C.muted }}>{connection.team} · {connection.project}</span>}
        <span style={{ flex: 1 }} />
        {data && (
          <select
            data-testid="planning-sprint-select"
            aria-label="Sprint"
            value={data.selected_sprint}
            disabled={busy}
            onChange={(e) => void act(() => planning.selectSprint(e.target.value))}
            style={input}
          >
            {data.iterations.map((i) => (
              <option key={i.path} value={i.path}>
                {i.name}{i.timeframe === "current" ? " (current in ADO)" : ""}
              </option>
            ))}
          </select>
        )}
        {connection && (
          <button data-testid="planning-refresh" aria-label="Refresh" title="Refresh from ADO" disabled={loading} onClick={() => void planning.refresh()} style={{ ...button, display: "inline-flex" }}>
            <ArrowPathIcon width={14} height={14} />
          </button>
        )}
        <button data-testid="planning-close" aria-label="Close planning" onClick={onClose} style={{ ...button, display: "inline-flex", border: "none", background: "none" }}>
          <XMarkIcon width={18} height={18} />
        </button>
      </header>

      {!connection ? (
        <section style={{ padding: 20, maxWidth: 640 }}>
          <h2 style={{ fontSize: 14, margin: "0 0 6px" }}>Connect to your team</h2>
          <p style={{ color: C.sub, margin: "0 0 10px" }}>
            Paste the link of your team's sprint or backlog in Azure DevOps (e.g. …/_sprints/taskboard/&lt;team&gt;/…). Uses your Azure CLI login (<code>az login</code>).
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <input data-testid="planning-connect-input" aria-label="Team sprint or backlog link" value={link} onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && link.trim()) void act(() => planning.connect(link.trim())); }}
              placeholder="https://dev.azure.com/<org>/<project>/_backlogs/backlog/<team>/…" style={{ ...input, flex: 1 }} />
            <button data-testid="planning-connect-submit" disabled={busy || !link.trim()} onClick={() => void act(() => planning.connect(link.trim()))} style={primary}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
          {actionError && <p role="alert" data-testid="planning-connect-error" style={{ color: C.red }}>{actionError}</p>}
        </section>
      ) : (
        <>
          {offer && data && (
            <div data-testid="planning-ended-banner" role="status" style={{ padding: "6px 14px", background: "#f9e2af22", borderBottom: `1px solid ${C.yellow}`, color: C.yellow, display: "flex", gap: 10, alignItems: "center" }}>
              {data.iterations.find((i) => i.path === data.selected_sprint)?.name} has finished.
              <button data-testid="planning-switch-current" onClick={() => void act(() => planning.selectSprint(offer.path))} style={button}>Switch to {offer.name}</button>
            </div>
          )}
          <nav role="tablist" style={{ display: "flex", gap: 4, padding: "8px 14px", borderBottom: `1px solid ${C.surface0}` }}>
            {TABS.map(([value, text]) => (
              <button key={value} role="tab" aria-selected={tab === value} data-testid={`planning-tab-${value}`} onClick={() => setTab(value)}
                style={{ ...button, borderRadius: 12, background: tab === value ? C.blue : C.mantle, color: tab === value ? C.crust : C.sub, border: `1px solid ${tab === value ? C.blue : C.surface1}` }}>
                {text}
              </button>
            ))}
          </nav>
          {(error || actionError) && <p role="alert" data-testid="planning-error" style={{ color: C.red, margin: "6px 14px 0" }}>{actionError ?? error}</p>}
          <main style={{ flex: 1, minHeight: 0, padding: "10px 14px", display: "flex", flexDirection: "column" }}>
            {!data ? (
              <p style={{ color: C.sub }}>{loading ? "Loading from ADO…" : "No data yet."}</p>
            ) : tab === "sprint" ? (
              <SprintTab data={data} now={now()} />
            ) : tab === "features" ? (
              <FeaturesTab data={data} />
            ) : tab === "plan-sprint" ? (
              <PlanSprintTab data={data} items={items} draft={draft} onAddChange={planning.addChange} onSetDraft={planning.setDraft} />
            ) : (
              <PlanFeatureTab data={data} items={items} draft={draft} onAddChange={planning.addChange} />
            )}
          </main>
          {(draft.length > 0 || (published && lastPublish)) && (
            <footer data-testid="planning-draft-bar" style={{ borderTop: `1px solid ${C.surface0}`, padding: "8px 14px", display: "grid", gap: 6 }}>
              {published && lastPublish && (
                <div data-testid="planning-publish-result" style={{ color: C.sub }}>
                  {lastPublish.written.length} published
                  {lastPublish.conflicts.length > 0 && <span style={{ color: C.peach }}> · {lastPublish.conflicts.length} changed in ADO</span>}
                  {lastPublish.failures.length > 0 && <span style={{ color: C.red }}> · {lastPublish.failures.length} failed</span>}
                  {lastPublish.conflicts.map((c) => (
                    <div key={`${c.id}:${c.field}`} data-testid={`planning-conflict-${c.id}`} style={{ color: C.peach }}>
                      “{c.title || `#${c.id}`}” changed in ADO — now {c.ado_value}. Your change is still in the draft.
                    </div>
                  ))}
                  {lastPublish.failures.map((f) => <div key={f.id} style={{ color: C.red }}>#{f.id}: {f.message}</div>)}
                </div>
              )}
              {draft.length > 0 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span data-testid="planning-draft-count" style={{ flex: 1, color: C.sub }}>{draftLabel(draft)}</span>
                  <button data-testid="planning-draft-review" aria-expanded={showDraft} onClick={() => setShowDraft(!showDraft)} style={button}>{showDraft ? "Hide" : "Review"}</button>
                  <button data-testid="planning-discard" disabled={busy} onClick={() => void act(async () => { await planning.setDraft([]); setPublished(false); })} style={button}>Discard</button>
                  <button data-testid="planning-publish" disabled={busy} onClick={() => void act(async () => { await planning.publish(); setPublished(true); })} style={primary}>
                    {busy ? "Publishing…" : "Publish to ADO"}
                  </button>
                </div>
              )}
              {showDraft && draft.length > 0 && (
                <ul data-testid="planning-draft-list" style={{ margin: 0, paddingLeft: 18, color: C.sub }}>
                  {draft.map((change, i) => <li key={i}>{describeChange(change, data, items)}</li>)}
                </ul>
              )}
            </footer>
          )}
        </>
      )}
    </div>
  );
}
