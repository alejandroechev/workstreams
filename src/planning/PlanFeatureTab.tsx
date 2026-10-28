import { useState } from "react";
import {
  featureSummaries,
  nextTempId,
  round,
  type Change,
  type PlanItem,
  type PlanningData,
} from "../domain/planning";
import { button, C, card, input, label, primary } from "./styles";

interface Props {
  data: PlanningData;
  /** The data with the draft applied. */
  items: PlanItem[];
  draft: Change[];
  onAddChange: (change: Change) => Promise<void>;
}

const parsePoints = (text: string): number | null => {
  const value = Number(text);
  return text.trim() === "" || !Number.isFinite(value) || value < 0 ? null : value;
};

/** One editable story row: title, free-number estimate, order, remove. */
function StoryRow({ story, onRetitle, onEstimate, onUp, onDown, onRemove }: {
  story: PlanItem;
  onRetitle: (title: string) => void;
  onEstimate: (points: number | null) => void;
  onUp?: () => void;
  onDown?: () => void;
  onRemove: () => void;
}) {
  const [title, setTitle] = useState(story.title);
  const [estimate, setEstimate] = useState(story.story_points === null ? "" : String(story.story_points));
  return (
    <div data-testid={`planning-pf-story-${story.id}`} style={{ ...card, display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
      <input
        data-testid={`planning-pf-title-${story.id}`}
        aria-label="Story title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (title.trim() && title.trim() !== story.title) onRetitle(title.trim()); }}
        style={{ ...input, flex: 1 }}
      />
      {!story.assigned_to_me && <span style={{ color: C.muted, fontSize: 11 }}>{story.assigned_to ?? "unassigned"}</span>}
      <input
        data-testid={`planning-pf-points-${story.id}`}
        aria-label="Story points"
        inputMode="decimal"
        value={estimate}
        placeholder="?"
        onChange={(e) => setEstimate(e.target.value)}
        onBlur={() => { const p = parsePoints(estimate); if (p !== story.story_points) onEstimate(p); }}
        style={{ ...input, width: 56, textAlign: "right" }}
      />
      <button data-testid={`planning-pf-up-${story.id}`} aria-label={`Move ${story.title} up`} disabled={!onUp} onClick={onUp} style={{ ...button, padding: "1px 6px" }}>↑</button>
      <button data-testid={`planning-pf-down-${story.id}`} aria-label={`Move ${story.title} down`} disabled={!onDown} onClick={onDown} style={{ ...button, padding: "1px 6px" }}>↓</button>
      <button data-testid={`planning-pf-remove-${story.id}`} aria-label={`Remove ${story.title}`} title="Sets it to Removed; nothing is deleted" onClick={onRemove} style={{ ...button, padding: "1px 6px", color: C.red }}>✕</button>
    </div>
  );
}

/**
 * Break a feature into estimated user stories: create a feature, add stories,
 * estimate, rename, reorder and remove them. Everything goes into the draft.
 */
export function PlanFeatureTab({ data, items, draft, onAddChange }: Props) {
  const features = featureSummaries(data, items);
  const [selected, setSelected] = useState<number | null>(features[0]?.feature.id ?? null);
  const [creating, setCreating] = useState(features.length === 0);
  const [newFeature, setNewFeature] = useState({ title: "", target: "", description: "" });
  const [newStory, setNewStory] = useState({ title: "", points: "", description: "" });
  const [error, setError] = useState<string | null>(null);
  const current = features.find((f) => f.feature.id === selected) ?? null;

  const run = (action: () => Promise<void>) => {
    setError(null);
    void action().catch((failure) => setError(String(failure instanceof Error ? failure.message : failure)));
  };

  const createFeature = () => run(async () => {
    const title = newFeature.title.trim();
    if (!title) return;
    const temp_id = nextTempId(draft);
    await onAddChange({ kind: "create_feature", temp_id, title, target_date: newFeature.target || null, description: newFeature.description.trim() || null });
    setSelected(temp_id);
    setCreating(false);
    setNewFeature({ title: "", target: "", description: "" });
  });

  const addStory = () => run(async () => {
    const title = newStory.title.trim();
    if (!title || !current) return;
    await onAddChange({
      kind: "create_story", temp_id: nextTempId(draft), parent: current.feature.id, title,
      points: parsePoints(newStory.points), description: newStory.description.trim() || null,
    });
    setNewStory({ title: "", points: "", description: "" });
  });

  /** New order for the whole list, as one order change per story whose order moves. */
  const reorder = (from: number, to: number) => run(async () => {
    if (!current) return;
    const list = [...current.stories];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    for (const [index, story] of list.entries()) {
      const order = (index + 1) * 1000;
      if (story.order !== order && story.id > 0) await onAddChange({ kind: "order", id: story.id, rev: story.rev, order });
    }
  });

  const typedPoints = parsePoints(newStory.points) ?? 0;
  const total = current ? round(current.done + current.pending + typedPoints) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, flex: 1, overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select
          data-testid="planning-feature-select"
          aria-label="Feature"
          value={creating ? "" : String(selected ?? "")}
          onChange={(e) => { setSelected(Number(e.target.value)); setCreating(false); }}
          style={{ ...input, flex: 1 }}
        >
          {creating && <option value="">New feature…</option>}
          {features.map((f) => (
            <option key={f.feature.id} value={String(f.feature.id)}>{f.feature.id < 0 ? "(new) " : ""}{f.feature.title}</option>
          ))}
        </select>
        <button data-testid="planning-new-feature" onClick={() => setCreating(true)} style={button}>+ New feature</button>
      </div>

      {creating ? (
        <section style={{ ...card, display: "grid", gap: 6, padding: 10 }}>
          <div style={label}>New feature</div>
          <input data-testid="planning-new-feature-title" aria-label="Feature title" placeholder="Title" value={newFeature.title}
            onChange={(e) => setNewFeature({ ...newFeature, title: e.target.value })} style={input} />
          <label style={{ color: C.sub, fontSize: 11, display: "flex", gap: 8, alignItems: "center" }}>
            Target date
            <input data-testid="planning-new-feature-target" type="date" value={newFeature.target}
              onChange={(e) => setNewFeature({ ...newFeature, target: e.target.value })} style={input} />
          </label>
          <textarea data-testid="planning-new-feature-description" aria-label="Feature description" placeholder="Description (optional)" rows={2}
            value={newFeature.description} onChange={(e) => setNewFeature({ ...newFeature, description: e.target.value })} style={{ ...input, resize: "vertical" }} />
          <div>
            <button data-testid="planning-create-feature" disabled={!newFeature.title.trim()} onClick={createFeature} style={primary}>Add feature to the draft</button>
          </div>
        </section>
      ) : current ? (
        <section>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 6 }}>
            <div style={label}>Stories</div>
            <span data-testid="planning-feature-total" style={{ color: C.text, fontWeight: 600 }}>{total} SP</span>
            <span style={{ color: C.muted, fontSize: 11 }}>
              {current.feature.target_date ? `target ${current.feature.target_date.slice(0, 10)}` : "no target date"}
            </span>
          </div>
          {current.stories.map((story, index) => (
            <StoryRow
              key={`${story.id}:${story.title}:${story.story_points}`}
              story={story}
              onRetitle={(title) => run(() => onAddChange({ kind: "retitle", id: story.id, rev: story.rev, title }))}
              onEstimate={(p) => run(() => onAddChange({ kind: "estimate", id: story.id, rev: story.rev, points: p }))}
              onUp={index > 0 ? () => reorder(index, index - 1) : undefined}
              onDown={index < current.stories.length - 1 ? () => reorder(index, index + 1) : undefined}
              onRemove={() => run(() => onAddChange({ kind: "remove", id: story.id, rev: story.rev }))}
            />
          ))}
          <div style={{ ...card, display: "grid", gap: 6, marginTop: 8 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <input data-testid="planning-new-story-title" aria-label="New story title" placeholder="New story title" value={newStory.title}
                onChange={(e) => setNewStory({ ...newStory, title: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") addStory(); }} style={{ ...input, flex: 1 }} />
              <input data-testid="planning-new-story-points" aria-label="New story points" placeholder="SP" inputMode="decimal" value={newStory.points}
                onChange={(e) => setNewStory({ ...newStory, points: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") addStory(); }} style={{ ...input, width: 56, textAlign: "right" }} />
              <button data-testid="planning-add-story" disabled={!newStory.title.trim()} onClick={addStory} style={primary}>Add story</button>
            </div>
            <textarea data-testid="planning-new-story-description" aria-label="New story description" placeholder="Description (optional)" rows={1}
              value={newStory.description} onChange={(e) => setNewStory({ ...newStory, description: e.target.value })} style={{ ...input, resize: "vertical" }} />
          </div>
        </section>
      ) : (
        <p style={{ color: C.sub, fontSize: 12 }}>Pick a feature, or create one.</p>
      )}
      {error && <p role="alert" style={{ color: C.red, fontSize: 11 }}>{error}</p>}
    </div>
  );
}
