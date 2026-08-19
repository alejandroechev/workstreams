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

  /**
   * Wrap a mutation so a backend failure becomes visible state rather than an
   * unhandled rejection. Every caller is fire-and-forget from an event
   * handler, so without this a failed write is indistinguishable from success.
   */
  const guard = useCallback(
    async (run: () => Promise<void>) => {
      try {
        setError(null);
        await run();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const createTask = useCallback(
    (title: string) =>
      guard(async () => {
        const trimmed = title.trim();
        if (!trimmed) return;
        await backend.createTask(trimmed);
        await reload();
      }),
    [backend, reload, guard],
  );

  const updateTask = useCallback(
    (id: string, updates: TaskUpdate) =>
      guard(async () => {
      // Capture the link change before writing, so the event can name what the
      // task moved *to* without re-reading the row.
      const linkChanged = updates.workstreamId !== undefined;
      await backend.updateTask(id, updates);
      if (linkChanged) {
        // Attaching a workstream is one of the few signals the app observes for
        // free, and it is exactly the kind of thing the hand-written devlog
        // recorded by hand ("moved this into its own branch").
        await backend.addTaskEvent(
          id,
          "workstream",
          updates.workstreamId ? "attached a workstream" : "detached its workstream",
          "auto",
        );
      }
      await reload();
      }),
    [backend, reload, guard],
  );

  /**
   * Moving a card *is* an event -- it is the single highest-volume signal the
   * app can capture for free, and it is what makes the generated devlog page
   * possible without the user typing anything at all.
   */
  const setStatus = useCallback(
    (id: string, status: TaskStatus) =>
      guard(async () => {
        await backend.updateTask(id, { status });
        const glyph = statusEmoji(status);
        await backend.addTaskEvent(
          id,
          "status",
          `${glyph ? `${glyph} ` : ""}${status.replace(/_/g, " ")}`,
          "auto",
        );
        await reload();
      }),
    [backend, reload, guard],
  );

  const setTaskLabels = useCallback(
    (id: string, names: string[]) =>
      guard(async () => {
        await backend.setTaskLabels(id, names);
        await reload();
      }),
    [backend, reload, guard],
  );

  const addSubtask = useCallback(
    (taskId: string, title: string) =>
      guard(async () => {
        const trimmed = title.trim();
        if (!trimmed) return;
        await backend.createSubtask(taskId, trimmed);
        await reload();
      }),
    [backend, reload, guard],
  );

  const setSubtaskStatus = useCallback(
    (id: string, status: TaskStatus) =>
      guard(async () => {
        await backend.updateSubtask(id, { status });
        await reload();
      }),
    [backend, reload, guard],
  );

  const deleteSubtask = useCallback(
    (id: string) =>
      guard(async () => {
        await backend.deleteSubtask(id);
        await reload();
      }),
    [backend, reload, guard],
  );

  const addEvent = useCallback(
    (taskId: string, kind: TaskEventKind, text: string) =>
      guard(async () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        await backend.addTaskEvent(taskId, kind, trimmed);
        await reload();
      }),
    [backend, reload, guard],
  );

  const addNote = useCallback(
    (taskId: string, text: string) => addEvent(taskId, "note", text),
    [addEvent],
  );

  const deleteEvent = useCallback(
    (id: string) =>
      guard(async () => {
        await backend.deleteTaskEvent(id);
        await reload();
      }),
    [backend, reload, guard],
  );

  const deleteTask = useCallback(
    (id: string) =>
      guard(async () => {
        await backend.deleteTask(id);
        await reload();
      }),
    [backend, reload, guard],
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
