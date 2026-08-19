/**
 * In-workstream quick note.
 *
 * This is the adoption path, not a convenience. The devlog survived because
 * editing it was faster than any tool: open the file, type a line. If logging
 * here means finding the board, finding the card and opening a panel, the wiki
 * wins again and the whole feature is dead weight.
 *
 * So the bar sits where the work already is, targets the task linked to this
 * workstream, and commits on Enter.
 *
 * It renders nothing when the workstream has no task. Workstreams without
 * tasks are an expected case, and a permanent "no task linked" prompt would be
 * noise on every one of them.
 */
import { useCallback, useEffect, useState } from "react";
import type { Backend } from "../backend/types";
import type { Task } from "../domain/tasks";

export interface WorkstreamQuickNoteProps {
  backend: Backend;
  workstreamId: string;
}

export function WorkstreamQuickNote({ backend, workstreamId }: WorkstreamQuickNoteProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [text, setText] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void backend
      .listTasks()
      .then((tasks) => {
        if (cancelled) return;
        setTask(tasks.find((t) => t.workstreamId === workstreamId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setTask(null);
      });
    return () => {
      cancelled = true;
    };
  }, [backend, workstreamId]);

  const submit = useCallback(async () => {
    if (!task) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    await backend.addTaskEvent(task.id, "note", trimmed, "manual");
    setText("");
    setFlash("logged");
    window.setTimeout(() => setFlash(null), 1500);
  }, [backend, task, text]);

  if (!task) return null;

  return (
    <div data-testid="quick-note" style={barStyle}>
      <span style={{ color: "#6c7086", fontSize: 10 }}>Log to</span>
      <span style={{ fontSize: 11 }}>{task.title}</span>
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
        <span data-testid="quick-note-flash" style={{ color: "#a6e3a1", fontSize: 10 }}>
          {flash}
        </span>
      )}
    </div>
  );
}

const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 8px",
  borderBottom: "1px solid #313244",
  background: "#181825",
  flexShrink: 0,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "#11111b",
  border: "1px solid #313244",
  borderRadius: 4,
  color: "#cdd6f4",
  fontSize: 11,
  fontFamily: "inherit",
  padding: "2px 6px",
};
