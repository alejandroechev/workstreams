import { useState } from "react";
import { byOrder, daysLeft, iterationByPath, sprintSummary, SPRINT_GOAL, type PlanItem, type PlanningData } from "../domain/planning";
import { C, card, label, points, STATE_COLORS, button } from "./styles";

const COLUMNS = ["New", "Active", "Resolved", "Closed"] as const;
const LAYOUT_KEY = "planning.layout";

function StoryCard({ story, feature }: { story: PlanItem; feature: string }) {
  return (
    <div data-testid={`planning-story-${story.id}`} data-state={story.state} style={{ ...card, marginBottom: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <a href={story.url} target="_blank" rel="noreferrer" style={{ flex: 1, color: C.text, textDecoration: "none" }}>{story.title}</a>
        <span data-testid={`planning-sp-${story.id}`} style={{ fontWeight: 700, color: story.story_points === null ? C.yellow : C.text }}>
          {points(story.story_points)}
        </span>
      </div>
      <div style={{ color: C.muted, fontSize: 10, marginTop: 3, display: "flex", gap: 6 }}>
        <span>{feature}</span>
        {story.tasks_total > 0 && <span data-testid={`planning-tasks-${story.id}`}>· {story.tasks_done}/{story.tasks_total} tasks</span>}
      </div>
    </div>
  );
}

/** Your user stories in the selected sprint, as ADO has them now (not the draft). */
export function SprintTab({ data, now }: { data: PlanningData; now: Date }) {
  const [layout, setLayout] = useState<"board" | "feature">(() => (localStorage.getItem(LAYOUT_KEY) === "feature" ? "feature" : "board"));
  const choose = (next: "board" | "feature") => { setLayout(next); localStorage.setItem(LAYOUT_KEY, next); };
  const summary = sprintSummary(data);
  const features = new Map(data.items.filter((i) => i.kind === "Feature").map((f) => [f.id, f.title]));
  const featureOf = (s: PlanItem) => (s.parent_id !== null && features.get(s.parent_id)) || "No feature of yours";
  const left = daysLeft(iterationByPath(data, data.selected_sprint), now);
  const groups = new Map<string, PlanItem[]>();
  for (const s of byOrder(summary.stories)) groups.set(featureOf(s), [...(groups.get(featureOf(s)) ?? []), s]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div data-testid="planning-sprint-header" style={{ fontSize: 13, color: C.text }}>
          <b>{summary.committed} / {SPRINT_GOAL} SP</b> committed · {summary.done} done · {summary.toGo} to go · {left} day{left === 1 ? "" : "s"} left
          {summary.notEstimated > 0 && <span style={{ color: C.yellow }}> · {summary.notEstimated} not estimated</span>}
        </div>
        <span style={{ flex: 1 }} />
        <div role="group" aria-label="Layout" style={{ display: "flex" }}>
          {([["board", "Board"], ["feature", "By feature"]] as const).map(([value, text], i) => (
            <button
              key={value}
              data-testid={`planning-layout-${value}`}
              aria-pressed={layout === value}
              onClick={() => choose(value)}
              style={{ ...button, borderRadius: i === 0 ? "4px 0 0 4px" : "0 4px 4px 0", background: layout === value ? C.surface0 : C.mantle, color: layout === value ? C.text : C.muted }}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {summary.stories.length === 0 && <p style={{ color: C.sub, fontSize: 12 }}>No user stories of yours in this sprint.</p>}
      {layout === "board" ? (
        <div style={{ display: "flex", gap: 8, overflowY: "auto", minHeight: 0 }}>
          {COLUMNS.map((state) => {
            const stories = byOrder(summary.stories.filter((s) => s.state === state));
            return (
              <section key={state} data-testid={`planning-column-${state}`} style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...label, color: STATE_COLORS[state], marginBottom: 6 }}>
                  {state} · {stories.reduce((n, s) => n + (s.story_points ?? 0), 0)} SP
                </div>
                {stories.map((s) => <StoryCard key={s.id} story={s} feature={featureOf(s)} />)}
              </section>
            );
          })}
        </div>
      ) : (
        <div style={{ overflowY: "auto", minHeight: 0 }}>
          {[...groups].map(([feature, stories]) => (
            <section key={feature} data-testid="planning-feature-group" style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 4 }}>{feature}</div>
              {stories.map((s) => (
                <div key={s.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontSize: 9, border: `1px solid ${STATE_COLORS[s.state] ?? C.muted}`, color: STATE_COLORS[s.state] ?? C.muted, borderRadius: 8, padding: "0 6px", minWidth: 54, textAlign: "center" }}>{s.state}</span>
                  <div style={{ flex: 1 }}><StoryCard story={s} feature={feature} /></div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
