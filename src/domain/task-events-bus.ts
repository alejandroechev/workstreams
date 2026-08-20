/**
 * "Tasks changed" notification bus.
 *
 * The quick-note bar in the status bar reads the task list once on mount, so
 * a task created afterwards — including by the sidebar's "Create task…"
 * action, which is precisely the moment you want to start logging against it —
 * would otherwise never appear until the app reloaded.
 *
 * A window CustomEvent rather than shared state, following the existing
 * `workbench-events` convention: the publisher (the board) and the subscriber
 * (the status bar) live in different trees, and neither should own the other.
 *
 * Deliberately payload-free. Subscribers re-read what they need, so no caller
 * has to predict which slice of the task list somebody else cares about.
 */
export const TASKS_CHANGED_EVENT = "workstreams:tasks-changed";

export function dispatchTasksChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TASKS_CHANGED_EVENT));
}

/** Subscribe; returns an unsubscribe function. */
export function subscribeTasksChanged(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => onChange();
  window.addEventListener(TASKS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(TASKS_CHANGED_EVENT, handler);
}
