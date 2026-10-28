import { useState } from "react";
import {
  candidates,
  gauge,
  outOfSprintIteration,
  round,
  sprintSummary,
  SPRINT_GOAL,
  type Change,
  type PlanItem,
  type PlanningData,
} from "../domain/planning";
import { button, C, card, label, points } from "./styles";

interface Props {
  data: PlanningData;
  /** The data with the draft applied. */
  items: PlanItem[];
  draft: Change[];
  onAddChange: (change: Change) => Promise<void>;
  onSetDraft: (draft: Change[]) => Promise<void>;
}

const GAUGE_COLORS = { under: C.yellow, on: C.green, over: C.peach } as const;

/**
 * Drag stories between your candidates and the selected sprint, with a gauge
 * against 8 story points. Every move goes into the draft; nothing is blocked.
 */
export function PlanSprintTab({ data, items, draft, onAddChange, onSetDraft }: Props) {
  const [over, setOver] = useState<"sprint" | "pool" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const planned = sprintSummary(data, items);
  const groups = candidates(data, items);
  const meter = gauge(planned.committed);
  const original = (id: number) => data.items.find((i) => i.id === id);

  const run = (action: () => Promise<void>) => {
    setError(null);
    void action().catch((failure) => setError(String(failure instanceof Error ? failure.message : failure)));
  };

  /** Into the sprint: a move, or undoing an earlier move out of it. */
  const putIn = (story: PlanItem) => run(async () => {
    const before = original(story.id);
    if (!before) return;
    if (before.iteration_path === data.selected_sprint) {
      await onSetDraft(draft.filter((c) => !(c.kind === "move" && c.id === story.id)));
    } else {
      await onAddChange({ kind: "move", id: story.id, rev: before.rev, to_iteration: data.selected_sprint, assign_to_me: !before.assigned_to });
    }
  });

  /** Out of the sprint: undo the move that put it there, or move it back to its feature's iteration. */
  const takeOut = (story: PlanItem) => run(async () => {
    const before = original(story.id);
    if (!before) return;
    if (before.iteration_path !== data.selected_sprint) {
      await onSetDraft(draft.filter((c) => !(c.kind === "move" && c.id === story.id)));
    } else {
      await onAddChange({ kind: "move", id: story.id, rev: before.rev, to_iteration: outOfSprintIteration(data, items, story), assign_to_me: false });
    }
  });

  const findStory = (id: number) => items.find((i) => i.id === id);
  const drop = (target: "sprint" | "pool") => (event: React.DragEvent) => {
    event.preventDefault();
    setOver(null);
    const story = findStory(Number(event.dataTransfer.getData("text/plain")));
    if (!story) return;
    if (target === "sprint" && story.iteration_path !== data.selected_sprint) putIn(story);
    if (target === "pool" && story.iteration_path === data.selected_sprint) takeOut(story);
  };
  const dragProps = (story: PlanItem) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => { event.dataTransfer.setData("text/plain", String(story.id)); event.dataTransfer.effectAllowed = "move"; },
  });
  const zone = (target: "sprint" | "pool") => ({
    onDragOver: (event: React.DragEvent) => { event.preventDefault(); setOver(target); },
    onDragLeave: () => setOver(null),
    onDrop: drop(target),
  });

  const row = (story: PlanItem, side: "pool" | "sprint", carry = false) => (
    <div
      key={story.id}
      data-testid={side === "pool" ? `planning-candidate-${story.id}` : `planning-planned-${story.id}`}
      {...dragProps(story)}
      style={{ ...card, marginBottom: 6, display: "flex", gap: 8, alignItems: "center", cursor: "grab", borderLeft: carry ? `3px solid ${C.peach}` : card.border }}
    >
      <span style={{ flex: 1 }}>{story.title}{!story.assigned_to && <span style={{ color: C.muted, fontSize: 10 }}> · unassigned</span>}</span>
      <span style={{ fontWeight: 700, color: story.story_points === null ? C.yellow : C.text }}>{points(story.story_points)}</span>
      <button
        aria-label={side === "pool" ? `Add ${story.title} to the sprint` : `Take ${story.title} out of the sprint`}
        data-testid={side === "pool" ? `planning-add-${story.id}` : `planning-take-out-${story.id}`}
        onClick={() => (side === "pool" ? putIn(story) : takeOut(story))}
        style={{ ...button, padding: "1px 6px" }}
      >
        {side === "pool" ? "→" : "←"}
      </button>
    </div>
  );

  const sprintName = data.iterations.find((i) => i.path === data.selected_sprint)?.name ?? data.selected_sprint;
  return (
    <div style={{ display: "flex", gap: 12, minHeight: 0, flex: 1 }}>
      <section
        data-testid="planning-candidates"
        {...zone("pool")}
        style={{ flex: 1, minWidth: 0, overflowY: "auto", outline: over === "pool" ? `2px dashed ${C.surface1}` : "none", padding: 4 }}
      >
        <div style={{ ...label, marginBottom: 6 }}>Candidates</div>
        {groups.length === 0 && <p style={{ color: C.sub, fontSize: 12 }}>Nothing left to plan.</p>}
        {groups.map((group) => (
          <div key={group.key} data-testid={`planning-candidate-group-${group.key}`} data-carry={group.carryOver}>
            <div style={{ color: group.carryOver ? C.peach : C.sub, fontSize: 11, margin: "6px 0 4px" }}>{group.label}</div>
            {group.stories.map((s) => row(s, "pool", group.carryOver))}
          </div>
        ))}
      </section>
      <section
        data-testid="planning-sprint-column"
        {...zone("sprint")}
        style={{ flex: 1, minWidth: 0, overflowY: "auto", outline: over === "sprint" ? `2px dashed ${C.surface1}` : "none", padding: 4 }}
      >
        <div style={{ ...label, marginBottom: 6 }}>{sprintName}</div>
        <div data-testid="planning-gauge" data-state={meter.state} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <b data-testid="planning-gauge-total" style={{ fontSize: 14, color: C.text }}>{round(planned.committed)} / {SPRINT_GOAL} SP</b>
            <span data-testid="planning-gauge-text" style={{ color: GAUGE_COLORS[meter.state], fontSize: 12 }}>
              {meter.text}{planned.notEstimated > 0 && ` · ${planned.notEstimated} not estimated`}
            </span>
          </div>
          <div style={{ position: "relative", height: 10, background: C.crust, border: `1px solid ${C.surface0}`, borderRadius: 5, marginTop: 4 }}>
            <div style={{ position: "absolute", inset: "0 auto 0 0", width: `${Math.min(100, (planned.committed / 12) * 100)}%`, background: GAUGE_COLORS[meter.state], borderRadius: 5 }} />
            <div title="Goal: 8 SP" style={{ position: "absolute", top: -3, bottom: -3, left: `${(SPRINT_GOAL / 12) * 100}%`, width: 2, background: C.text }} />
          </div>
        </div>
        {planned.stories.map((s) => row(s, "sprint"))}
        {error && <p role="alert" style={{ color: C.red, fontSize: 11 }}>{error}</p>}
      </section>
    </div>
  );
}
