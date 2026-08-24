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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  XMarkIcon,
  PlusIcon,
  TrashIcon,
  ArrowTopRightOnSquareIcon,
  Bars3BottomLeftIcon,
} from "@heroicons/react/24/outline";

import type { Backend } from "../backend/types";
import type { Project, Workstream } from "../domain/types";
import type { Task } from "../domain/tasks";
import type { BoardColumnId } from "../domain/task-status";
import {
  toLocalDate,
  previousWorkDay,
  eventsForTask,
  eventsOnDate,
  sortEvents,
} from "../domain/tasks";
import {
  BOARD_COLUMNS,
  SELECTABLE_STATUSES,
  statusEmoji,
  columnForStatus,
  isTerminalStatus,
  type TaskStatus,
} from "../domain/task-status";
import {
  swimlanes,
  visibleTasks,
  filterByRepo,
  statusForDrop,
  subtaskProgress,
} from "../domain/task-board";
import { renderDevlogDay } from "../domain/devlog-render";
import { useTaskBoard } from "./useTaskBoard";
import { dispatchTasksChanged } from "../domain/task-events-bus";

export interface TaskBoardProps {
  backend: Backend;
  workstreams: Workstream[];
  projects: Project[];
  onClose: () => void;
  /** Injectable for tests; defaults to the real local day. */
  today?: string;
  /** Wiki folder the generated page is written to. Empty disables export. */
  devlogDirectory?: string;
  /**
   * Navigate to a workstream. Optional so the board stays renderable in
   * isolation; the link is plain text when it is not supplied.
   */
  onOpenWorkstream?: (workstreamId: string) => void;
  /**
   * When set, open with a freshly created task for this workstream, named
   * after it and already selected. Used by the sidebar's "Create task…"
   * action so the workstream can be turned into a task in one step.
   */
  createForWorkstreamId?: string | null;
  /** Fired once the request above has been carried out, so it is not replayed. */
  onCreateForWorkstreamHandled?: () => void;
  /**
   * Open with this task already selected. Used by the sidebar's "Go to task"
   * action for a workstream that already has one.
   */
  focusTaskId?: string | null;
  /** Fired once the focus request has been carried out. */
  onFocusTaskHandled?: () => void;
}

/** Subtasks shown inline on a card before the rest are summarised. */
const CARD_SUBTASK_LIMIT = 5;

/**
 * Clear an input after a successful write, but only if it still holds exactly
 * what was submitted.
 *
 * Two things must both be true. A failed write must never clear the box, or
 * the text is lost from the screen as well as from the database. And a slow
 * success must never clear a *newer* draft the user started typing while the
 * request was in flight.
 */
function clearIfUnchanged(
  ok: boolean,
  set: React.Dispatch<React.SetStateAction<string>>,
  submitted: string,
): void {
  if (!ok) return;
  set((current) => (current === submitted ? "" : current));
}

/**
 * Options for a status picker: the selectable set, plus whatever the row
 * currently holds.
 *
 * The `current` part matters. A task still on a retired status would otherwise
 * render a `<select>` whose value matches no option, which browsers resolve by
 * silently showing the first one -- so the task would look like a To do until
 * somebody touched it.
 */
function statusOptions(current: TaskStatus): TaskStatus[] {
  const options: TaskStatus[] = [...SELECTABLE_STATUSES];
  if (!options.includes(current)) options.push(current);
  return options;
}

/** `HH:MM` in the user's own timezone. */
function localClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(11, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  parked: "Parked",
  delegated: "Delegated",
  persistent: "Persistent",
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
  devlogDirectory = "",
  onOpenWorkstream,
  createForWorkstreamId = null,
  onCreateForWorkstreamHandled,
  focusTaskId = null,
  onFocusTaskHandled,
}: TaskBoardProps) {
  const board = useTaskBoard(backend);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [labelText, setLabelText] = useState("");
  const [exportDay, setExportDay] = useState<"yesterday" | "today">("yesterday");
  const [preview, setPreview] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<BoardColumnId | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");

  const lanes = useMemo(() => {
    const scoped = filterByRepo(board.tasks, workstreams, repoFilter);
    return swimlanes(visibleTasks(scoped, today, { showAllDone }), board.labels, {
      events: board.events,
      today,
    });
  }, [board.tasks, board.labels, board.events, workstreams, repoFilter, showAllDone, today]);

  const endDrag = () => {
    setDraggingId(null);
    setDropColumn(null);
  };

  /**
   * Apply a drop. `statusForDrop` returns null when the card landed back on
   * the column it already rendered in, which must stay a true no-op: writing
   * the column's own status would flatten `investigating` into `in_progress`
   * (and `cancelled` into `done`) just because a card was picked up and put
   * down again.
   */
  const handleDrop = (column: BoardColumnId) => {
    const task = board.tasks.find((t) => t.id === draggingId);
    endDrag();
    if (!task) return;
    const next = statusForDrop(task, column);
    if (next) void board.setStatus(task.id, next);
  };

  const openWorkstream = (workstreamId: string) => {
    if (!onOpenWorkstream) return;
    onOpenWorkstream(workstreamId);
    // The board is a full-screen overlay, so navigating without closing it
    // would leave the user looking at the board they just navigated away from.
    onClose();
  };

  /**
   * The day the export writes up.
   *
   * The last **work day** by default: the export normally runs at the start of
   * a working day and covers the one just finished, so on a Monday that means
   * Friday rather than an empty Sunday. Today is offered too, for writing a day
   * up before it ends -- and stays literal, since picking it on a Sunday means
   * that Sunday. The choice also decides which event-log entries and which
   * completions belong on the page.
   */
  const exportDate = exportDay === "today" ? today : previousWorkDay(`${today}T12:00:00`);

  const renderPage = () =>
    renderDevlogDay({
      date: exportDate,
      tasks: board.tasks,
      events: board.events,
      labels: board.labels,
      workstreams,
    });

  /**
   * Export is manual and one-way. It refuses outright when no folder is
   * configured rather than guessing a path, because a wrong guess would
   * scatter generated pages through the user's wiki.
   */
  const runExport = async () => {
    if (!devlogDirectory) {
      setExportStatus("Devlog folder is not configured — set it in Settings.");
      return;
    }
    setExportStatus("Exporting…");
    try {
      const result = await backend.exportDevlogDay(devlogDirectory, exportDate, renderPage(), {
        commit: true,
        push: true,
      });
      const bits = [`Wrote ${exportDate} → ${result.path}`];
      if (result.commit) bits.push(`commit ${result.commit.slice(0, 8)}`);
      if (result.pushed) bits.push("pushed");
      if (result.warning) bits.push(result.warning);
      setExportStatus(bits.join(" · "));
    } catch (err) {
      setExportStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const selected: Task | null = board.tasks.find((t) => t.id === selectedId) ?? null;

  // Resync the title box when the selection changes, or it would keep showing
  // the previously selected task's name. Keyed on id and title so an external
  // rename lands too, but not on every render, which would fight typing.
  const titleSourceRef = useRef<string | null>(null);
  const titleKey = selected ? `${selected.id}:${selected.title}` : null;
  if (titleKey !== titleSourceRef.current) {
    titleSourceRef.current = titleKey;
    if (titleDraft !== (selected?.title ?? "")) setTitleDraft(selected?.title ?? "");
  }

  const notesSourceRef = useRef<string | null>(null);
  const notesKey = selected ? `${selected.id}:${selected.notes}` : null;
  if (notesKey !== notesSourceRef.current) {
    notesSourceRef.current = notesKey;
    if (notesDraft !== (selected?.notes ?? "")) setNotesDraft(selected?.notes ?? "");
  }

  /**
   * Commit the free-form note.
   *
   * Deliberately NOT recorded as an event: notes are current understanding,
   * the activity log is history. Logging every revision would bury the day's
   * real events under successive drafts of the same paragraph.
   *
   * An empty note is a legitimate value here (unlike the title), because
   * clearing the scratchpad is a real thing to want.
   */
  const commitNotes = () => {
    if (!selected) return;
    if (notesDraft === selected.notes) return;
    void board.updateTask(selected.id, { notes: notesDraft });
  };

  /**
   * Commit a rename. A blank title is refused rather than saved: the title is
   * the only handle a task has on the board and in the exported page, so an
   * empty one would make it unfindable. Unchanged titles skip the write.
   */
  const commitTitle = () => {
    if (!selected) return;
    const next = titleDraft.trim();
    if (!next) {
      setTitleDraft(selected.title);
      return;
    }
    if (next === selected.title) return;
    void board.updateTask(selected.id, { title: next });
  };

  // Select a requested task once its row has loaded. Guarded like the create
  // request so a re-render cannot keep re-selecting and fighting the user's
  // own clicks.
  const handledFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTaskId || board.loading) return;
    if (handledFocusRef.current === focusTaskId) return;
    handledFocusRef.current = focusTaskId;
    if (board.tasks.some((t) => t.id === focusTaskId)) setSelectedId(focusTaskId);
    onFocusTaskHandled?.();
  }, [focusTaskId, board.loading, board.tasks, onFocusTaskHandled]);

  /**
   * Honour a "create a task for this workstream" request exactly once.
   *
   * The ref guard matters: StrictMode double-invokes effects and any re-render
   * would otherwise mint a second task, so opening the board from the sidebar
   * would quietly accumulate duplicates.
   */
  const handledCreateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!createForWorkstreamId || board.loading) return;
    if (handledCreateRef.current === createForWorkstreamId) return;
    handledCreateRef.current = createForWorkstreamId;

    const ws = workstreams.find((w) => w.id === createForWorkstreamId);
    if (!ws) {
      onCreateForWorkstreamHandled?.();
      return;
    }
    void backend
      .createTask(ws.name, { workstreamId: ws.id })
      .then(async (task) => {
        await board.reload();
        setSelectedId(task.id);
        // This path bypasses the hook's guard(), so it announces the change
        // itself; otherwise the quick note would not see the task it was
        // just created for.
        dispatchTasksChanged();
      })
      .finally(() => onCreateForWorkstreamHandled?.());
  }, [createForWorkstreamId, board, backend, workstreams, onCreateForWorkstreamHandled]);
  // Keep an open preview in step with the selected day; a preview left showing
  // the other day's page is worse than no preview at all.
  useEffect(() => {
    if (preview === null) return;
    setPreview(renderPage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportDate, board.tasks, board.events, board.labels]);

  /**
   * Today's entries only.
   *
   * The feed is a working view of what has happened so far today, not an
   * archive -- yesterday's entries have already been written up. Older ones
   * stay reachable behind a toggle rather than being hidden outright, because
   * delete lives in this list and a typo from yesterday would otherwise be
   * impossible to remove.
   */
  const allSelectedEvents = selected
    ? sortEvents(eventsForTask(board.events, selected.id))
    : [];
  const todaysEvents = eventsOnDate(allSelectedEvents, today);
  const selectedEvents = showAllEvents ? allSelectedEvents : todaysEvents;
  const earlierEventCount = allSelectedEvents.length - todaysEvents.length;

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
                void board.createTask(newTitle).then((ok) => clearIfUnchanged(ok, setNewTitle, newTitle));
              }
            }}
            style={{ ...controlStyle, width: 220 }}
          />
          <button
            data-testid="new-task-submit"
            onClick={() => void board.createTask(newTitle).then((ok) => clearIfUnchanged(ok, setNewTitle, newTitle))}
            style={controlStyle}
          >
            <PlusIcon style={{ width: 12, height: 12 }} />
          </button>

          <select
            data-testid="devlog-day"
            value={exportDay}
            onChange={(e) => setExportDay(e.target.value as "yesterday" | "today")}
            style={controlStyle}
            title="Which day the devlog page covers"
          >
            <option value="yesterday">Last work day</option>
            <option value="today">Today</option>
          </select>
          <span data-testid="devlog-day-label" style={{ color: "#6c7086", fontSize: 10 }}>
            {exportDate}
          </span>

          <button
            data-testid="devlog-preview"
            onClick={() => setPreview(renderPage())}
            style={controlStyle}
            title={`Preview the generated devlog page for ${exportDate} without writing it`}
          >
            Preview
          </button>
          <button
            data-testid="devlog-export"
            onClick={() => void runExport()}
            style={controlStyle}
            title={`Write, commit and push the devlog page for ${exportDate}`}
          >
            Export
          </button>

          <button data-testid="board-close" onClick={onClose} style={controlStyle} title="Close">
            <XMarkIcon style={{ width: 14, height: 14 }} />
          </button>
        </header>

        {board.loading && (
          <p data-testid="board-loading" style={statusBarStyle}>
            Loading tasks…
          </p>
        )}

        {board.error && (
          <p data-testid="board-error" style={{ ...statusBarStyle, color: "#f38ba8" }}>
            {board.error}
          </p>
        )}

        {exportStatus && (
          <p data-testid="devlog-status" style={statusBarStyle}>
            {exportStatus}
          </p>
        )}

        {preview !== null && (
          <div style={previewWrapStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <strong style={{ fontSize: 11 }}>
                Preview for {exportDate} — nothing has been written
              </strong>
              <div style={{ flex: 1 }} />
              <button
                data-testid="devlog-preview-close"
                onClick={() => setPreview(null)}
                style={controlStyle}
              >
                Close preview
              </button>
            </div>
            <pre data-testid="devlog-preview-content" style={previewStyle}>
              {preview}
            </pre>
          </div>
        )}

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
                  {BOARD_COLUMNS.map((column) => {
                    const isDropTarget = dropColumn === column.id && draggingId !== null;
                    return (
                    <div
                      key={column.id}
                      data-testid={`lane-column-${column.id}`}
                      data-drop-active={isDropTarget ? "true" : "false"}
                      onDragOver={(e) => {
                        if (!draggingId) return;
                        // Without preventDefault the browser refuses the drop.
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dropColumn !== column.id) setDropColumn(column.id);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleDrop(column.id);
                      }}
                      style={{
                        ...laneCellStyle,
                        background: isDropTarget ? "#1e1e2e" : "transparent",
                        outline: isDropTarget ? "1px dashed #89b4fa" : "1px solid transparent",
                        borderRadius: 4,
                      }}
                    >
                      {lane.columns[column.id].map((task) => {
                        const progress = subtaskProgress(task);
                        const shown = task.subtasks.slice(0, CARD_SUBTASK_LIMIT);
                        const hidden = task.subtasks.length - shown.length;
                        const linkedWs = task.workstreamId
                          ? workstreams.find((w) => w.id === task.workstreamId)
                          : undefined;
                        return (
                        <div
                          key={task.id}
                          data-testid={`task-card-${task.id}`}
                          role="button"
                          tabIndex={0}
                          draggable
                          onDragStart={(e) => {
                            setDraggingId(task.id);
                            e.dataTransfer.effectAllowed = "move";
                            try {
                              e.dataTransfer.setData("text/plain", task.id);
                            } catch {
                              /* jsdom and some browsers reject setData */
                            }
                          }}
                          onDragEnd={endDrag}
                          onClick={() => setSelectedId(task.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") setSelectedId(task.id);
                          }}
                          style={{
                            ...cardStyle,
                            borderColor: task.id === selectedId ? "#89b4fa" : "#313244",
                            opacity: draggingId === task.id ? 0.4 : 1,
                            cursor: draggingId === task.id ? "grabbing" : "grab",
                          }}
                        >
                          <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                            <span aria-hidden style={{ minWidth: 12 }}>
                              {statusEmoji(task.status)}
                            </span>
                            <span style={{ flex: 1 }}>{task.title}</span>
                            {task.notes.trim() && (
                              <span
                                data-testid={`card-has-notes-${task.id}`}
                                title="Has notes"
                                style={{ color: "#6c7086", fontSize: 9 }}
                              >
                                <Bars3BottomLeftIcon style={{ width: 10, height: 10 }} />
                              </span>
                            )}
                            {task.touchedToday && (
                              <span data-testid={`touched-${task.id}`} style={touchedStyle}>
                                today
                              </span>
                            )}
                          </div>

                          {progress.total > 0 && (
                            <div style={{ marginTop: 3 }}>
                              <span
                                data-testid={`card-progress-${task.id}`}
                                style={{ color: "#6c7086", fontSize: 9 }}
                              >
                                {progress.done}/{progress.total} subtasks
                              </span>
                              {shown.map((sub) => (
                                <div
                                  key={sub.id}
                                  data-testid={`card-subtask-${sub.id}`}
                                  style={subtaskRowStyle}
                                >
                                  <span aria-hidden>{statusEmoji(sub.status) || "·"}</span>
                                  <span
                                    style={{
                                      flex: 1,
                                      textDecoration: isTerminalStatus(sub.status)
                                        ? "line-through"
                                        : "none",
                                    }}
                                  >
                                    {sub.title}
                                  </span>
                                </div>
                              ))}
                              {hidden > 0 && (
                                <div
                                  data-testid={`card-more-${task.id}`}
                                  style={{ ...subtaskRowStyle, color: "#585b70" }}
                                >
                                  +{hidden} more
                                </div>
                              )}
                            </div>
                          )}

                          {linkedWs &&
                            (onOpenWorkstream ? (
                              <button
                                data-testid={`card-workstream-${task.id}`}
                                // The card is itself clickable, so the link has
                                // to stop the event or navigating would also
                                // open the detail panel behind it.
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openWorkstream(linkedWs.id);
                                }}
                                style={wsLinkStyle}
                                title={`Go to ${linkedWs.name}`}
                              >
                                <ArrowTopRightOnSquareIcon style={{ width: 9, height: 9 }} />
                                {linkedWs.name}
                              </button>
                            ) : (
                              <span style={{ ...wsLinkStyle, cursor: "default" }}>
                                {linkedWs.name}
                              </span>
                            ))}
                        </div>
                        );
                      })}
                    </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          {selected && (
            <aside style={detailStyle} data-testid="task-detail">
              <label style={{ ...fieldLabelStyle, marginTop: 0 }}>Title</label>
              <input
                data-testid="detail-title"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") setTitleDraft(selected.title);
                }}
                style={{ ...controlStyle, width: "100%", fontSize: 12, cursor: "text" }}
              />

              <label style={fieldLabelStyle}>Status</label>
              <select
                data-testid="detail-status"
                value={selected.status}
                onChange={(e) => void board.setStatus(selected.id, e.target.value as TaskStatus)}
                style={controlStyle}
              >
                {statusOptions(selected.status).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                    {columnForStatus(status) !== status ? ` (in ${columnForStatus(status)})` : ""}
                  </option>
                ))}
              </select>

              <label style={fieldLabelStyle}>Workstream</label>
              {selected.workstreamId && onOpenWorkstream && (
                <button
                  data-testid="detail-open-workstream"
                  onClick={() => openWorkstream(selected.workstreamId!)}
                  style={{ ...wsLinkStyle, marginTop: 0, marginBottom: 4 }}
                >
                  <ArrowTopRightOnSquareIcon style={{ width: 10, height: 10 }} />
                  Go to{" "}
                  {workstreams.find((w) => w.id === selected.workstreamId)?.name ??
                    selected.workstreamId}
                </button>
              )}
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
                      .then((ok) => clearIfUnchanged(ok, setLabelText, labelText));
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
                    {statusOptions(sub.status).map((status) => (
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
                    void board.addSubtask(selected.id, subtaskTitle).then((ok) => clearIfUnchanged(ok, setSubtaskTitle, subtaskTitle))
                  }
                  style={controlStyle}
                >
                  Add
                </button>
              </div>

              <label style={fieldLabelStyle}>Notes</label>
              <textarea
                data-testid="detail-notes"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                onBlur={commitNotes}
                placeholder="Free-form context: design decisions, open questions, whatever doesn't fit above"
                style={{
                  ...controlStyle,
                  width: "100%",
                  // Take the panel's spare height rather than a fixed row
                  // count: notes are the field most likely to be long, and
                  // everything above them is a single line.
                  flex: 1,
                  minHeight: 90,
                  boxSizing: "border-box",
                  cursor: "text",
                  resize: "none",
                  fontFamily: "inherit",
                  lineHeight: 1.5,
                }}
              />

              <label style={fieldLabelStyle}>Activity</label>
              {earlierEventCount > 0 && (
                <button
                  data-testid="event-show-all"
                  onClick={() => setShowAllEvents((v) => !v)}
                  style={{
                    ...controlStyle,
                    alignSelf: "flex-start",
                    marginBottom: 3,
                    fontSize: 10,
                  }}
                >
                  {showAllEvents
                    ? "Show today only"
                    : `${earlierEventCount} earlier — show all`}
                </button>
              )}
              <div data-testid="event-feed" style={{ maxHeight: 220, overflow: "auto" }}>
                {selectedEvents.map((event) => (
                  <div key={event.id} style={eventRowStyle}>
                    {/* Local clock, not the stored UTC slice: a note typed at
                        21:00 must not read as 01:00 here while the exported
                        page correctly files it under today. */}
                    <span style={{ color: "#6c7086", fontSize: 10 }}>
                      {localClock(event.at)}
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
                  data-testid="log-input"
                  value={noteText}
                  placeholder="Log what just happened"
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void board.addNote(selected.id, noteText).then((ok) => clearIfUnchanged(ok, setNoteText, noteText));
                    }
                  }}
                  style={{ ...controlStyle, flex: 1 }}
                />
                <button
                  data-testid="log-submit"
                  onClick={() => void board.addNote(selected.id, noteText).then((ok) => clearIfUnchanged(ok, setNoteText, noteText))}
                  style={controlStyle}
                >
                  Log
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
  display: "flex",
  flexDirection: "column",
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
  // A flex column so the notes box has spare height to grow into. `minHeight:
  // 0` is what lets it shrink inside the flex parent instead of overflowing.
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
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

const statusBarStyle: React.CSSProperties = {
  margin: 0,
  padding: "4px 10px",
  borderBottom: "1px solid #313244",
  color: "#a6adc8",
  fontSize: 11,
};

const previewWrapStyle: React.CSSProperties = {
  borderBottom: "1px solid #313244",
  padding: "6px 10px",
  maxHeight: "40%",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const previewStyle: React.CSSProperties = {
  margin: 0,
  overflow: "auto",
  background: "#11111b",
  border: "1px solid #313244",
  borderRadius: 4,
  padding: 8,
  fontSize: 11,
  whiteSpace: "pre-wrap",
};

const subtaskRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  fontSize: 9,
  color: "#a6adc8",
  paddingLeft: 14,
  lineHeight: 1.5,
};

const wsLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  marginTop: 4,
  padding: "1px 4px",
  background: "#11111b",
  border: "1px solid #313244",
  borderRadius: 3,
  color: "#89b4fa",
  fontSize: 9,
  fontFamily: "inherit",
  cursor: "pointer",
  alignSelf: "flex-start",
};
