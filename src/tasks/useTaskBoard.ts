/**
 * Board data hook.
 *
 * Loads the whole task set at once: the board is global (a task may have no
 * workstream, and workstreams outlive tasks), the real set is ~60 rows, and
 * swimlanes need every task in memory to group them anyway.
 *
 * Every mutation reloads rather than patching local state. That is deliberate
 * for v1 -- label dedupe and the `completedAt` stamp are both decided by the
 * backend, so optimistically guessing them in the UI would let the two drift.
 */
import { useCallback, useEffect, useState } from "react";
import type { Backend, TaskUpdate } from "../backend/types";
import type { Task, Label, TaskEvent, TaskEventKind } from "../domain/tasks";
import type { TaskStatus } from "../domain/task-status";
import { statusEmoji } from "../domain/task-status";

export interface TaskBoardData {
  tasks: Task[];
  labels: Label[];
  events: TaskEvent[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createTask: (title: string) => Promise<void>;
  updateTask: (id: string, updates: TaskUpdate) => Promise<void>;
  setStatus: (id: string, status: TaskStatus) => Promise<void>;
  setLabels: (id: string, names: string[]) => Promise<void>;
  addSubtask: (taskId: string, title: string) => Promise<void>;
  setSubtaskStatus: (id: string, status: TaskStatus) => Promise<void>;
  deleteSubtask: (id: string) => Promise<void>;
  addNote: (taskId: string, text: string) => Promise<void>;
  addEvent: (taskId: string, kind: TaskEventKind, text: string) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
}

export function useTaskBoard(backend: Backend): TaskBoardData {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [t, l, e] = await Promise.all([
        backend.listTasks(),
        backend.listLabels(),
        backend.listTaskEvents(),
      ]);
      setTasks(t);
      setLabels(l);
      setEvents(e);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createTask = useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      await backend.createTask(trimmed);
      await reload();
    },
    [backend, reload],
  );

  const updateTask = useCallback(
    async (id: string, updates: TaskUpdate) => {
      await backend.updateTask(id, updates);
      await reload();
    },
    [backend, reload],
  );

  /**
   * Moving a card *is* an event -- it is the single highest-volume signal the
   * app can capture for free, and it is what makes the generated devlog page
   * possible without the user typing anything at all.
   */
  const setStatus = useCallback(
    async (id: string, status: TaskStatus) => {
      await backend.updateTask(id, { status });
      const glyph = statusEmoji(status);
      await backend.addTaskEvent(
        id,
        "status",
        `${glyph ? `${glyph} ` : ""}${status.replace(/_/g, " ")}`,
        "auto",
      );
      await reload();
    },
    [backend, reload],
  );

  const setTaskLabels = useCallback(
    async (id: string, names: string[]) => {
      await backend.setTaskLabels(id, names);
      await reload();
    },
    [backend, reload],
  );

  const addSubtask = useCallback(
    async (taskId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      await backend.createSubtask(taskId, trimmed);
      await reload();
    },
    [backend, reload],
  );

  const setSubtaskStatus = useCallback(
    async (id: string, status: TaskStatus) => {
      await backend.updateSubtask(id, { status });
      await reload();
    },
    [backend, reload],
  );

  const deleteSubtask = useCallback(
    async (id: string) => {
      await backend.deleteSubtask(id);
      await reload();
    },
    [backend, reload],
  );

  const addEvent = useCallback(
    async (taskId: string, kind: TaskEventKind, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await backend.addTaskEvent(taskId, kind, trimmed);
      await reload();
    },
    [backend, reload],
  );

  const addNote = useCallback(
    (taskId: string, text: string) => addEvent(taskId, "note", text),
    [addEvent],
  );

  const deleteEvent = useCallback(
    async (id: string) => {
      await backend.deleteTaskEvent(id);
      await reload();
    },
    [backend, reload],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      await backend.deleteTask(id);
      await reload();
    },
    [backend, reload],
  );

  return {
    tasks,
    labels,
    events,
    loading,
    error,
    reload,
    createTask,
    updateTask,
    setStatus,
    setLabels: setTaskLabels,
    addSubtask,
    setSubtaskStatus,
    deleteSubtask,
    addNote,
    addEvent,
    deleteEvent,
    deleteTask,
  };
}
