import { featureSummaries, type PlanningData } from "../domain/planning";
import { C, card, points, STATE_COLORS } from "./styles";

/** Your open features as ADO has them: target, done vs pending, risk, every story. */
export function FeaturesTab({ data }: { data: PlanningData }) {
  const features = featureSummaries(data);
  return (
    <div style={{ overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {features.length === 0 && <p style={{ color: C.sub, fontSize: 12 }}>No open features assigned to you.</p>}
      {features.map((f) => {
        const total = f.done + f.pending;
        return (
          <section key={f.feature.id} data-testid={`planning-feature-${f.feature.id}`} style={{ ...card, padding: "8px 10px" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <a href={f.feature.url} target="_blank" rel="noreferrer" style={{ color: C.text, fontWeight: 600, textDecoration: "none" }}>{f.feature.title}</a>
              <span style={{ color: C.muted, fontSize: 11 }}>
                {f.feature.target_date ? `target ${f.feature.target_date.slice(0, 10)}` : "no target date"}
                {f.sprintsLeft !== null && ` · ${f.sprintsLeft} sprint${f.sprintsLeft === 1 ? "" : "s"} left`}
              </span>
              {f.atRisk && (
                <span data-testid={`planning-feature-risk-${f.feature.id}`} style={{ color: C.peach, fontSize: 11, fontWeight: 600 }}>
                  at risk
                </span>
              )}
            </div>
            <div style={{ height: 6, background: C.crust, borderRadius: 3, margin: "6px 0", overflow: "hidden" }}>
              <div style={{ width: `${total > 0 ? (f.done / total) * 100 : 0}%`, height: "100%", background: C.green }} />
            </div>
            <div data-testid={`planning-feature-numbers-${f.feature.id}`} style={{ color: C.sub, fontSize: 11 }}>
              {f.done} SP done · {f.pending} SP pending ({f.myPending} yours)
              {f.notEstimated > 0 && <span style={{ color: C.yellow }}> · {f.notEstimated} not estimated</span>}
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0", display: "grid", gap: 3 }}>
              {f.stories.map((s) => (
                <li key={s.id} data-testid={`planning-feature-story-${s.id}`} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}>
                  <span style={{ fontSize: 9, border: `1px solid ${STATE_COLORS[s.state] ?? C.muted}`, color: STATE_COLORS[s.state] ?? C.muted, borderRadius: 8, padding: "0 6px", minWidth: 54, textAlign: "center" }}>{s.state}</span>
                  <a href={s.url} target="_blank" rel="noreferrer" style={{ flex: 1, color: C.text, textDecoration: "none" }}>{s.title}</a>
                  {!s.assigned_to_me && <span style={{ color: C.muted, fontSize: 11 }}>{s.assigned_to ?? "unassigned"}</span>}
                  <span style={{ fontWeight: 700, color: s.story_points === null ? C.yellow : C.text, minWidth: 18, textAlign: "right" }}>{points(s.story_points)}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
