import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TASKS_CHANGED_EVENT,
  dispatchTasksChanged,
  subscribeTasksChanged,
} from "../task-events-bus";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("tasks-changed bus", () => {
  it("notifies subscribers", () => {
    const seen = vi.fn();
    cleanups.push(subscribeTasksChanged(seen));
    dispatchTasksChanged();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const seen = vi.fn();
    subscribeTasksChanged(seen)();
    dispatchTasksChanged();
    expect(seen).not.toHaveBeenCalled();
  });

  it("notifies every subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    cleanups.push(subscribeTasksChanged(a), subscribeTasksChanged(b));
    dispatchTasksChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("uses a namespaced event name so it cannot collide", () => {
    expect(TASKS_CHANGED_EVENT).toBe("workstreams:tasks-changed");
  });

  it("is safe to dispatch with nobody listening", () => {
    expect(() => dispatchTasksChanged()).not.toThrow();
  });
});
