/**
 * In-workstream quick note.
 *
 * This is the adoption path, not a convenience. The devlog survived because
 * editing it was faster than any tool: open the file, type a line. If logging
 * here means finding the board, finding the card and opening a panel, the wiki
 * wins again and the whole feature is dead weight.
 *
 * So it sits where the work already is -- inline in the bottom status bar,
 * beside the tile controls -- targets the task linked to this workstream, and
 * commits on Enter.
 *
 * It lives in that bar rather than as its own strip above the tile grid
 * because a dedicated strip cost vertical space on every workstream, including
 * the majority that have no task bound at all.
 *
 * It renders nothing when the workstream has no task. Workstreams without
 * tasks are an expected case, and a permanent "no task linked" prompt would be
 * noise on every one of them.
 */
import { useCallback, useEffect, useState } from "react";
import type { Backend } from "../backend/types";
import type { Task } from "../domain/tasks";
import { subscribeTasksChanged } from "../domain/task-events-bus";

export interface WorkstreamQuickNoteProps {
  backend: Backend;
  workstreamId: string;
}

export function WorkstreamQuickNote({ backend, workstreamId }: WorkstreamQuickNoteProps) {
  const [matches, setMatches] = useState<Task[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void backend
        .listTasks()
        .then((tasks) => {
          if (cancelled) return;
          const mine = tasks.filter((t) => t.workstreamId === workstreamId);
          setMatches(mine);
          setTargetId((prev) =>
            prev && mine.some((t) => t.id === prev) ? prev : (mine[0]?.id ?? null),
          );
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        });
    };

    load();
    // Reloading on the bus is what makes "Create task…" usable: the task is
    // created after this bar has already mounted, and without this the note
    // would not appear until the app restarted.
    const unsubscribe = subscribeTasksChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [backend, workstreamId]);

  // Nothing constrains one task per workstream, so several can legitimately
  // point here. Picking the first silently would file notes under the wrong
  // task -- and therefore the wrong section of the archive.
  const task = matches.find((t) => t.id === targetId) ?? null;

  const submit = useCallback(async () => {
    if (!task) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await backend.addTaskEvent(task.id, "note", trimmed, "manual");
      // Only clear if the box still holds what was sent: a slow success must
      // not wipe a newer draft typed while the request was in flight.
      setText((current) => (current === text ? "" : current));
      setFlash("logged");
    } catch (err) {
      // Silently swallowing this would look identical to success and lose
      // the note the user just typed.
      setFlash(err instanceof Error ? err.message : "could not log the note");
    }
    window.setTimeout(() => setFlash(null), 2500);
  }, [backend, task, text]);

  if (!task) return null;

  return (
    <div data-testid="quick-note" style={barStyle}>
      <span style={{ color: "#6c7086", flexShrink: 0 }}>Log to</span>
      {matches.length > 1 ? (
        <select
          data-testid="quick-note-target"
          value={task.id}
          onChange={(e) => setTargetId(e.target.value)}
          style={{ ...inputStyle, flex: "0 0 auto", maxWidth: 180 }}
        >
          {matches.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      ) : (
        <span
          title={task.title}
          style={{
            color: "#a6adc8",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {task.title}
        </span>
      )}
      <input
        data-testid="quick-note-input"
        value={text}
        placeholder="What just happened?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        style={inputStyle}
      />
      {flash && (
        <span
          data-testid="quick-note-flash"
          style={{ color: "#a6e3a1", flexShrink: 0, whiteSpace: "nowrap" }}
        >
          {flash}
        </span>
      )}
    </div>
  );
}

/**
 * Inline, not a bar. The surrounding status bar owns the background, border
 * and vertical padding; adding our own here would draw a second bar inside the
 * first and make the row taller than the tile controls beside it.
 */
const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  flex: 1,
  margin: "0 10px",
  fontSize: 11,
  fontFamily: "monospace",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 80,
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 4,
  color: "#cdd6f4",
  fontSize: 11,
  fontFamily: "inherit",
  padding: "1px 6px",
};
