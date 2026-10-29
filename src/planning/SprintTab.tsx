import { useState } from "react";
import {
  applyDraft,
  byOrder,
  daysLeft,
  iterationByPath,
  resolveOffer,
  SETTABLE_STATES,
  sprintSummary,
  SPRINT_GOAL,
  taskProgress,
  type Change,
  type PlanItem,
  type PlanningData,
  type PlanTask,
} from "../domain/planning";
import { C, card, label, points, STATE_COLORS, button } from "./styles";

const COLUMNS = ["New", "Active", "Resolved", "Closed"] as const;
const LAYOUT_KEY = "planning.layout";
const SHOW_TASKS_KEY = "planning.showTasks";

interface TaskActions {
  draft: Change[];
  /** Expanded by hand, or by the Show tasks switch. */
  expanded: boolean;
  onToggle: () => void;
  /** Hidden until the story's task states differ from this signature. */
  dismissedAt: string | undefined;
  onDismiss: (signature: string) => void;
  onSetState: (task: PlanTask, original: PlanTask, state: string) => void;
  onResolve: (story: PlanItem) => void;
}

function TaskRow({ task, original, pending, onSetState }: { task: PlanTask; original: PlanTask; pending: boolean; onSetState: TaskActions["onSetState"] }) {
  return (
    <div data-testid={`planning-task-${task.id}`} data-state={task.state} style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 6, paddingLeft: 6, borderLeft: `2px solid ${C.surface0}`, fontSize: 11 }}>
      <a href={task.url} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, color: C.sub, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</a>
      {!task.assigned_to_me && task.assigned_to && <span style={{ color: C.muted, fontSize: 10 }}>{task.assigned_to}</span>}
      {pending && <span data-testid={`planning-task-pending-${task.id}`} title={`In ADO: ${original.state}`} style={{ color: C.peach, fontSize: 10 }}>● not published</span>}
      <select
        data-testid={`planning-task-state-${task.id}`}
        aria-label={`State of ${task.title}`}
        value={task.state}
        onChange={(e) => onSetState(task, original, e.target.value)}
        style={{ fontSize: 10, color: pending ? C.peach : STATE_COLORS[task.state] ?? C.sub, background: C.crust, border: `1px solid ${C.surface1}`, borderRadius: 8, padding: "0 4px", fontFamily: "inherit" }}
      >
        {(SETTABLE_STATES as readonly string[]).includes(task.state) ? null : <option value={task.state}>{task.state}</option>}
        {SETTABLE_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
      </select>
    </div>
  );
}

function StoryCard({ story, planned, feature, actions }: { story: PlanItem; planned: PlanItem; feature: string; actions: TaskActions }) {
  const progress = taskProgress(planned);
  const tasks = planned.tasks ?? [];
  const pendingResolve = actions.draft.some((c) => c.kind === "set_state" && c.id === story.id);
  const signature = tasks.map((t) => `${t.id}:${t.state}`).join(",");
  const offer = !pendingResolve && resolveOffer(planned) && actions.dismissedAt !== signature;
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
        {progress.total > 0 && (
          <button
            data-testid={`planning-tasks-${story.id}`}
            aria-expanded={tasks.length > 0 ? actions.expanded : undefined}
            onClick={actions.onToggle}
            style={{ background: "none", border: "none", padding: 0, color: "inherit", font: "inherit", cursor: tasks.length > 0 ? "pointer" : "default" }}
          >
            · {progress.done}/{progress.total} tasks{tasks.length > 0 && (actions.expanded ? " ▾" : " ▸")}
          </button>
        )}
      </div>
      {actions.expanded && tasks.length > 0 && (
        <div style={{ display: "grid", gap: 2, marginTop: 4 }}>
          {tasks.map((task) => {
            const original = story.tasks?.find((t) => t.id === task.id) ?? task;
            const pending = actions.draft.some((c) => c.kind === "set_state" && c.id === task.id);
            return <TaskRow key={task.id} task={task} original={original} pending={pending} onSetState={actions.onSetState} />;
          })}
        </div>
      )}
      {pendingResolve && (
        <div data-testid={`planning-resolve-pending-${story.id}`} style={{ marginTop: 4, fontSize: 10, color: C.peach }}>● Resolve story — not published</div>
      )}
      {offer && (
        <div data-testid={`planning-resolve-offer-${story.id}`} style={{ marginTop: 4, fontSize: 10, color: C.green, border: `1px solid ${C.green}`, borderRadius: 4, padding: "2px 6px", display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ flex: 1 }}>All tasks done — resolve the story?</span>
          <button data-testid={`planning-resolve-${story.id}`} onClick={() => actions.onResolve(story)} style={{ ...button, padding: "0 6px", fontSize: 10 }}>Resolve</button>
          <button data-testid={`planning-resolve-dismiss-${story.id}`} aria-label="Not now" onClick={() => actions.onDismiss(signature)} style={{ ...button, padding: "0 6px", fontSize: 10 }}>✕</button>
        </div>
      )}
    </div>
  );
}

interface Props {
  data: PlanningData;
  now: Date;
  draft?: Change[];
  onAddChange?: (change: Change) => Promise<void>;
  onSetDraft?: (draft: Change[]) => Promise<void>;
}

/**
 * Your user stories in the selected sprint, as ADO has them now. Their tasks
 * show drafted states (marked not published), and a story whose tasks are all
 * done offers to be resolved through the draft.
 */
export function SprintTab({ data, now, draft = [], onAddChange, onSetDraft }: Props) {
  const [layout, setLayout] = useState<"board" | "feature">(() => (localStorage.getItem(LAYOUT_KEY) === "feature" ? "feature" : "board"));
  const choose = (next: "board" | "feature") => { setLayout(next); localStorage.setItem(LAYOUT_KEY, next); };
  const [showTasks, setShowTasks] = useState(() => localStorage.getItem(SHOW_TASKS_KEY) !== "0");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [dismissed, setDismissed] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const switchTasks = () => {
    const next = !showTasks;
    setShowTasks(next);
    setExpanded({});
    localStorage.setItem(SHOW_TASKS_KEY, next ? "1" : "0");
  };
  const planned = new Map(applyDraft(data, draft).map((i) => [i.id, i]));
  const run = (action: () => Promise<void>) => {
    setError(null);
    void action().catch((failure) => setError(String(failure instanceof Error ? failure.message : failure)));
  };
  const actionsFor = (story: PlanItem): TaskActions => ({
    draft,
    expanded: expanded[story.id] ?? showTasks,
    onToggle: () => setExpanded((e) => ({ ...e, [story.id]: !(e[story.id] ?? showTasks) })),
    dismissedAt: dismissed[story.id],
    onDismiss: (signature) => setDismissed((d) => ({ ...d, [story.id]: signature })),
    onSetState: (task, original, state) => run(async () => {
      if (state === original.state) {
        await onSetDraft?.(draft.filter((c) => !(c.kind === "set_state" && c.id === task.id)));
      } else {
        await onAddChange?.({ kind: "set_state", id: task.id, rev: original.rev, state });
      }
    }),
    onResolve: (s) => run(async () => { await onAddChange?.({ kind: "set_state", id: s.id, rev: s.rev, state: "Resolved" }); }),
  });
  const storyCard = (s: PlanItem, feature: string) => (
    <StoryCard key={s.id} story={s} planned={planned.get(s.id) ?? s} feature={feature} actions={actionsFor(s)} />
  );
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
        <button data-testid="planning-show-tasks" aria-pressed={showTasks} onClick={switchTasks} style={{ ...button, color: showTasks ? C.text : C.muted }}>
          {showTasks ? "☑" : "☐"} Show tasks
        </button>
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
      {error && <p role="alert" style={{ color: C.red, fontSize: 11, margin: 0 }}>{error}</p>}
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
                {stories.map((s) => storyCard(s, featureOf(s)))}
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
                  <div style={{ flex: 1 }}>{storyCard(s, feature)}</div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
