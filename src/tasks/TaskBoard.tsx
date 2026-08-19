/**
 * Global task board.
 *
 * Deliberately *not* a tile: tiles are bound to one workstream, but a task may
 * have no workstream at all and often outlives the one it had. The board is a
 * sibling of the workstream list, reached from the sidebar, in the same way
 * the Repo Manager is.
 *
 * The layout is driven by a measured problem: 45 of the 61 real tasks sit in
 * `in_progress`, so a plain column view is one unreadable stack. Swimlanes by
 * label split it into short rows, and the Done column is scoped to today so it
 * cannot become a graveyard.
 */
import { useMemo, useState } from "react";
import { XMarkIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";

import type { Backend } from "../backend/types";
import type { Project, Workstream } from "../domain/types";
import type { Task } from "../domain/tasks";
import { toLocalDate, eventsForTask, sortEvents } from "../domain/tasks";
import {
  BOARD_COLUMNS,
  TASK_STATUSES,
  statusEmoji,
  columnForStatus,
  type TaskStatus,
} from "../domain/task-status";
import { swimlanes, visibleTasks, filterByRepo } from "../domain/task-board";
import { useTaskBoard } from "./useTaskBoard";

export interface TaskBoardProps {
  backend: Backend;
  workstreams: Workstream[];
  projects: Project[];
  onClose: () => void;
  /** Injectable for tests; defaults to the real local day. */
  today?: string;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  parked: "Parked",
  delegated: "Delegated",
  done: "Done",
  investigating: "Investigating",
  cancelled: "Cancelled",
};

export function TaskBoard({
  backend,
  workstreams,
  projects,
  onClose,
  today = toLocalDate(new Date().toISOString()),
}: TaskBoardProps) {
  const board = useTaskBoard(backend);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [labelText, setLabelText] = useState("");

  const lanes = useMemo(() => {
    const scoped = filterByRepo(board.tasks, workstreams, repoFilter);
    return swimlanes(visibleTasks(scoped, today, { showAllDone }), board.labels, {
      events: board.events,
      today,
    });
  }, [board.tasks, board.labels, board.events, workstreams, repoFilter, showAllDone, today]);

  const selected: Task | null = board.tasks.find((t) => t.id === selectedId) ?? null;
  const selectedEvents = selected ? sortEvents(eventsForTask(board.events, selected.id)) : [];

  return (
    <div style={overlayStyle} data-testid="task-board">
      <div style={panelStyle}>
        <header style={headerStyle}>
          <strong style={{ fontSize: 13 }}>Tasks</strong>

          <select
            data-testid="repo-filter"
            value={repoFilter ?? ""}
            onChange={(e) => setRepoFilter(e.target.value || null)}
            style={controlStyle}
          >
            <option value="">All repos</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <label style={{ ...controlStyle, display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="checkbox"
              data-testid="toggle-show-all-done"
              checked={showAllDone}
              onChange={(e) => setShowAllDone(e.target.checked)}
            />
            Show all done
          </label>

          <div style={{ flex: 1 }} />

          <input
            data-testid="new-task-input"
            value={newTitle}
            placeholder="New task"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void board.createTask(newTitle).then(() => setNewTitle(""));
              }
            }}
            style={{ ...controlStyle, width: 220 }}
          />
          <button
            data-testid="new-task-submit"
            onClick={() => void board.createTask(newTitle).then(() => setNewTitle(""))}
            style={controlStyle}
          >
            <PlusIcon style={{ width: 12, height: 12 }} />
          </button>

          <button data-testid="board-close" onClick={onClose} style={controlStyle} title="Close">
            <XMarkIcon style={{ width: 14, height: 14 }} />
          </button>
        </header>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
            <div style={columnHeaderRowStyle}>
              {BOARD_COLUMNS.map((column) => (
                <div key={column.id} data-testid={`board-column-${column.id}`} style={columnHeadStyle}>
                  {column.label}
                </div>
              ))}
            </div>

            {lanes.length === 0 && (
              <p data-testid="board-empty" style={{ color: "#6c7086", fontSize: 12, padding: 12 }}>
                No tasks yet. Add one above.
              </p>
            )}

            {lanes.map((lane) => (
              <section key={lane.id} data-testid={`swimlane-${lane.name}`} style={{ marginBottom: 10 }}>
                <h3 style={{ ...laneHeadStyle, color: lane.color ?? "#6c7086" }}>{lane.name}</h3>
                <div style={laneRowStyle}>
                  {BOARD_COLUMNS.map((column) => (
                    <div
                      key={column.id}
                      data-testid={`lane-column-${column.id}`}
                      style={laneCellStyle}
                    >
                      {lane.columns[column.id].map((task) => (
                        <button
                          key={task.id}
                          data-testid={`task-card-${task.id}`}
                          onClick={() => setSelectedId(task.id)}
                          style={{
                            ...cardStyle,
                            borderColor: task.id === selectedId ? "#89b4fa" : "#313244",
                          }}
                        >
                          <span aria-hidden style={{ minWidth: 12 }}>
                            {statusEmoji(task.status)}
                          </span>
                          <span style={{ flex: 1 }}>{task.title}</span>
                          {task.touchedToday && (
                            <span data-testid={`touched-${task.id}`} style={touchedStyle}>
                              today
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {selected && (
            <aside style={detailStyle} data-testid="task-detail">
              <h2 style={{ fontSize: 13, margin: "0 0 8px" }}>{selected.title}</h2>

              <label style={fieldLabelStyle}>Status</label>
              <select
                data-testid="detail-status"
                value={selected.status}
                onChange={(e) => void board.setStatus(selected.id, e.target.value as TaskStatus)}
                style={controlStyle}
              >
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                    {columnForStatus(status) !== status ? ` (in ${columnForStatus(status)})` : ""}
                  </option>
                ))}
              </select>

              <label style={fieldLabelStyle}>Workstream</label>
              <select
                data-testid="detail-workstream"
                value={selected.workstreamId ?? ""}
                onChange={(e) =>
                  void board.updateTask(selected.id, {
                    workstreamId: e.target.value || null,
                  })
                }
                style={controlStyle}
              >
                <option value="">None</option>
                {workstreams.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>

              <label style={fieldLabelStyle}>Labels</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                {selected.labelIds.map((id) => {
                  const label = board.labels.find((l) => l.id === id);
                  return (
                    <span key={id} data-testid={`task-label-${id}`} style={chipStyle}>
                      {label?.name ?? id}
                    </span>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  data-testid="label-input"
                  list="task-label-options"
                  value={labelText}
                  placeholder="Add label"
                  onChange={(e) => setLabelText(e.target.value)}
                  style={{ ...controlStyle, flex: 1 }}
                />
                <datalist id="task-label-options">
                  {board.labels.map((l) => (
                    <option key={l.id} value={l.name} />
                  ))}
                </datalist>
                <button
                  data-testid="label-submit"
                  onClick={() => {
                    const names = selected.labelIds
                      .map((id) => board.labels.find((l) => l.id === id)?.name)
                      .filter((n): n is string => Boolean(n));
                    void board
                      .setLabels(selected.id, [...names, labelText])
                      .then(() => setLabelText(""));
                  }}
                  style={controlStyle}
                >
                  Add
                </button>
              </div>

              <label style={fieldLabelStyle}>Subtasks</label>
              {selected.subtasks.map((sub) => (
                <div key={sub.id} style={{ display: "flex", gap: 4, marginBottom: 3 }}>
                  <select
                    data-testid={`subtask-status-${sub.id}`}
                    value={sub.status}
                    onChange={(e) =>
                      void board.setSubtaskStatus(sub.id, e.target.value as TaskStatus)
                    }
                    style={{ ...controlStyle, width: 90 }}
                  >
                    {TASK_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABEL[status]}
                      </option>
                    ))}
                  </select>
                  <span style={{ flex: 1, fontSize: 11 }}>{sub.title}</span>
                  <button
                    data-testid={`subtask-delete-${sub.id}`}
                    onClick={() => void board.deleteSubtask(sub.id)}
                    style={iconBtnStyle}
                  >
                    <TrashIcon style={{ width: 11, height: 11 }} />
                  </button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  data-testid="new-subtask-input"
                  value={subtaskTitle}
                  placeholder="Add subtask"
                  onChange={(e) => setSubtaskTitle(e.target.value)}
                  style={{ ...controlStyle, flex: 1 }}
                />
                <button
                  data-testid="new-subtask-submit"
                  onClick={() =>
                    void board.addSubtask(selected.id, subtaskTitle).then(() => setSubtaskTitle(""))
                  }
                  style={controlStyle}
                >
                  Add
                </button>
              </div>

              <label style={fieldLabelStyle}>Activity</label>
              <div data-testid="event-feed" style={{ maxHeight: 220, overflow: "auto" }}>
                {selectedEvents.map((event) => (
                  <div key={event.id} style={eventRowStyle}>
                    <span style={{ color: "#6c7086", fontSize: 10 }}>
                      {event.at.slice(11, 16)}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 11,
                        fontStyle: event.source === "auto" ? "italic" : "normal",
                        color: event.source === "auto" ? "#6c7086" : "#cdd6f4",
                      }}
                    >
                      {event.text}
                    </span>
                    {/* Delete only. Event text is immutable by design, so no
                        edit control exists anywhere in this panel. */}
                    <button
                      data-testid={`event-delete-${event.id}`}
                      onClick={() => void board.deleteEvent(event.id)}
                      style={iconBtnStyle}
                      title="Delete event"
                    >
                      <TrashIcon style={{ width: 11, height: 11 }} />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <input
                  data-testid="note-input"
                  value={noteText}
                  placeholder="Add a note"
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void board.addNote(selected.id, noteText).then(() => setNoteText(""));
                    }
                  }}
                  style={{ ...controlStyle, flex: 1 }}
                />
                <button
                  data-testid="note-submit"
                  onClick={() => void board.addNote(selected.id, noteText).then(() => setNoteText(""))}
                  style={controlStyle}
                >
                  Note
                </button>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(17,17,27,0.75)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 60,
};

const panelStyle: React.CSSProperties = {
  background: "#181825",
  border: "1px solid #313244",
  borderRadius: 8,
  width: "min(1400px, 96vw)",
  height: "min(900px, 92vh)",
  display: "flex",
  flexDirection: "column",
  color: "#cdd6f4",
  fontSize: 12,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 10px",
  borderBottom: "1px solid #313244",
};

const controlStyle: React.CSSProperties = {
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 4,
  color: "#cdd6f4",
  fontSize: 11,
  fontFamily: "inherit",
  padding: "3px 6px",
  cursor: "pointer",
};

const columnHeaderRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: `repeat(${BOARD_COLUMNS.length}, minmax(120px, 1fr))`,
  gap: 6,
  marginBottom: 6,
};

const columnHeadStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#6c7086",
};

const laneHeadStyle: React.CSSProperties = { fontSize: 11, margin: "0 0 4px" };

const laneRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: `repeat(${BOARD_COLUMNS.length}, minmax(120px, 1fr))`,
  gap: 6,
};

const laneCellStyle: React.CSSProperties = {
  minHeight: 26,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const cardStyle: React.CSSProperties = {
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 4,
  color: "#cdd6f4",
  fontSize: 11,
  fontFamily: "inherit",
  padding: "4px 6px",
  textAlign: "left",
  cursor: "pointer",
  display: "flex",
  gap: 4,
  alignItems: "flex-start",
};

const touchedStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#a6e3a1",
  border: "1px solid #313244",
  borderRadius: 3,
  padding: "0 3px",
};

const detailStyle: React.CSSProperties = {
  width: 320,
  borderLeft: "1px solid #313244",
  padding: 10,
  overflow: "auto",
};

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  textTransform: "uppercase",
  color: "#6c7086",
  margin: "10px 0 3px",
};

const chipStyle: React.CSSProperties = {
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 10,
  fontSize: 10,
  padding: "1px 6px",
};

const eventRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 5,
  alignItems: "baseline",
  padding: "2px 0",
  borderBottom: "1px solid #1e1e2e",
};

const iconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#6c7086",
  cursor: "pointer",
  padding: 0,
};
