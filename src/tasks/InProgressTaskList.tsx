/**
 * Always-on "what am I doing right now" list, under the sidebar's Tasks button.
 *
 * A permanent view of in-progress work, so the answer is visible without
 * opening the board. It deliberately mirrors the workstream-row style — a
 * coloured left edge, title, and dimmer secondary lines — because it sits
 * directly beneath that list and reads as part of the same column.
 *
 * Clicking a row goes to the bound workstream, since that is where the work
 * actually happens. A task with no workstream has nowhere else to go, so it
 * falls back to opening the task on the board rather than being inert.
 *
 * The list is capped at roughly three rows and scrolls: it is a peripheral
 * view, and letting it grow with 45 in-progress tasks would push the
 * workstream list off the screen entirely.
 */
import { useCallback, useEffect, useState } from "react";

import type { Backend } from "../backend/types";
import type { Workstream } from "../domain/types";
import type { Label, Task } from "../domain/tasks";
import { inProgressTasks } from "../domain/task-board";
import { statusEmoji } from "../domain/task-status";
import { subscribeTasksChanged } from "../domain/task-events-bus";

export interface InProgressTaskListProps {
  backend: Backend;
  workstreams: Workstream[];
  /** Navigate to a workstream (the common case). */
  onOpenWorkstream: (workstreamId: string) => void;
  /** Open the board focused on a task, for rows with no workstream. */
  onOpenTask: (taskId: string) => void;
  /** Highlights the row whose workstream is currently open. */
  activeWsId?: string | null;
}

/** Three rows plus a sliver, so a fourth is visibly cut off rather than hidden. */
const MAX_HEIGHT = 132;

export function InProgressTaskList({
  backend,
  workstreams,
  onOpenWorkstream,
  onOpenTask,
  activeWsId = null,
}: InProgressTaskListProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void Promise.all([backend.listTasks(), backend.listLabels()])
        .then(([allTasks, allLabels]) => {
          if (cancelled) return;
          setTasks(inProgressTasks(allTasks));
          setLabels(allLabels);
        })
        .catch(() => {
          if (!cancelled) setTasks([]);
        });
    };

    load();
    // Without the bus this would only ever show what existed at mount, and the
    // whole point is that it is always current.
    const unsubscribe = subscribeTasksChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [backend]);

  /**
   * Clicking a row goes to the bound workstream -- unless you are already in
   * it, in which case navigating would be a no-op and the click would appear
   * to do nothing. There, opening the task on the board is the only useful
   * thing left. A task with no workstream always opens on the board, since
   * there is nowhere else for it to go.
   */
  const open = useCallback(
    (task: Task) => {
      if (task.workstreamId && task.workstreamId !== activeWsId) {
        onOpenWorkstream(task.workstreamId);
      } else {
        onOpenTask(task.id);
      }
    },
    [onOpenWorkstream, onOpenTask, activeWsId],
  );

  return (
    <div data-testid="in-progress-list" style={listStyle}>
      {tasks.length === 0 && (
        <div data-testid="in-progress-empty" style={emptyStyle}>
          Nothing in progress
        </div>
      )}

      {tasks.map((task) => {
        const label = labels.find((l) => l.id === task.labelIds[0]);
        const ws = task.workstreamId
          ? workstreams.find((w) => w.id === task.workstreamId)
          : undefined;
        const isActive = ws !== undefined && ws.id === activeWsId;

        return (
          <div
            key={task.id}
            data-testid={`in-progress-task-${task.id}`}
            data-active={isActive ? "true" : "false"}
            role="button"
            tabIndex={0}
            onClick={() => open(task)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") open(task);
            }}
            title={
              ws && !isActive ? `Go to ${ws.name}` : "Open this task on the board"
            }
            style={{
              ...rowStyle,
              background: isActive ? "#313244" : "transparent",
              borderLeftColor: label?.color ?? "#45475a",
            }}
            onMouseEnter={(e) => {
              if (!isActive) (e.currentTarget as HTMLElement).style.background = "#1e1e2e";
            }}
            onMouseLeave={(e) => {
              if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <div style={titleRowStyle}>
              <span aria-hidden style={{ flexShrink: 0 }}>
                {statusEmoji(task.status)}
              </span>
              <span style={titleStyle}>{task.title}</span>
            </div>

            {label && (
              <div style={{ ...subtitleStyle, color: label.color }}>{label.name}</div>
            )}

            {ws && <div style={subtitleStyle}>{`ws:${ws.name}`}</div>}
          </div>
        );
      })}
    </div>
  );
}

const listStyle: React.CSSProperties = {
  maxHeight: MAX_HEIGHT,
  overflowY: "auto",
  padding: "0 6px 4px",
  flexShrink: 0,
};

const emptyStyle: React.CSSProperties = {
  color: "#45475a",
  fontSize: 10,
  padding: "2px 8px 4px",
};

const rowStyle: React.CSSProperties = {
  padding: "4px 6px",
  marginBottom: 1,
  borderRadius: 4,
  borderLeft: "3px solid #45475a",
  cursor: "pointer",
  transition: "background 0.1s",
};

const titleRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  alignItems: "baseline",
  fontSize: 11,
  color: "#cdd6f4",
};

const titleStyle: React.CSSProperties = {
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#6c7086",
  paddingLeft: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
