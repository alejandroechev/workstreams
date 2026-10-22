import { describe, it, expect } from "vitest";
import {
  initialCreatingState,
  openWhenProvisioned,
  initialArchivingState,
  applyWorktreeEvent,
  type WorktreeProgressEvent,
} from "../worktree-provisioning";

const ev = (p: Partial<WorktreeProgressEvent>): WorktreeProgressEvent => ({
  workstreamId: "w1",
  phase: "creating",
  detail: "",
  status: "running",
  ...p,
});

describe("worktree provisioning reducer", () => {
  it("starts in creating / archiving", () => {
    expect(initialCreatingState().status).toBe("creating");
    expect(initialArchivingState().status).toBe("archiving");
    expect(initialCreatingState().steps).toEqual([]);
  });

  it("accumulates running steps and tracks the current phase", () => {
    let s = initialCreatingState();
    s = applyWorktreeEvent(s, ev({ phase: "pulling-base", detail: "Pulling latest main" }));
    s = applyWorktreeEvent(s, ev({ phase: "creating", detail: "git worktree add" }));
    expect(s.status).toBe("creating");
    expect(s.steps.map((x) => x.phase)).toEqual(["pulling-base", "creating"]);
    expect(s.phase).toBe("git worktree add");
  });

  it("create done → active", () => {
    let s = initialCreatingState();
    s = applyWorktreeEvent(s, ev({ status: "done", phase: "created", op: "create" }));
    expect(s.status).toBe("active");
    expect(s.phase).toBeNull();
  });

  it("create error → create_failed with the error message", () => {
    let s = initialCreatingState();
    s = applyWorktreeEvent(s, ev({ status: "error", detail: "branch already exists", op: "create" }));
    expect(s.status).toBe("create_failed");
    expect(s.error).toBe("branch already exists");
  });

  it("pull-skipped is a non-fatal warning, create still proceeds", () => {
    let s = initialCreatingState();
    s = applyWorktreeEvent(s, ev({ phase: "pull-skipped", detail: "offline; used local base" }));
    expect(s.status).toBe("creating");
    expect(s.warning).toContain("offline");
    s = applyWorktreeEvent(s, ev({ status: "done", phase: "created", op: "create" }));
    expect(s.status).toBe("active");
  });

  it("archive done → archived", () => {
    let s = initialArchivingState();
    s = applyWorktreeEvent(s, ev({ status: "done", phase: "removed", op: "archive" }));
    expect(s.status).toBe("archived");
  });

  it("archive error → archived + warning (archive succeeded, only removal failed)", () => {
    let s = initialArchivingState();
    s = applyWorktreeEvent(s, ev({ status: "error", detail: "dir locked", op: "archive" }));
    expect(s.status).toBe("archived");
    expect(s.warning).toContain("dir locked");
  });

  it("infers op from the current state when the event omits it", () => {
    expect(applyWorktreeEvent(initialCreatingState(), ev({ status: "done" })).status).toBe("active");
    expect(applyWorktreeEvent(initialArchivingState(), ev({ status: "done" })).status).toBe("archived");
  });

  it("is total: ignores events after a terminal state (duplicate done / error-after-done)", () => {
    let s = initialCreatingState();
    s = applyWorktreeEvent(s, ev({ status: "done", op: "create" }));
    expect(s.status).toBe("active");
    const after = applyWorktreeEvent(s, ev({ status: "error", detail: "late", op: "create" }));
    expect(after.status).toBe("active");
    expect(after.error).toBeNull();
    const after2 = applyWorktreeEvent(after, ev({ status: "done", op: "create" }));
    expect(after2.status).toBe("active");
  });
});

describe("openWhenProvisioned", () => {
  const ws = (id: string, status: string) => ({ id, status });
  it("selects a ready worktree if you're still where you created it, else loads it in the background", () => {
    const pending = new Map<string, string | null>([["a", "home"], ["b", "home"], ["c", null]]);
    const plan = openWhenProvisioned(pending, [ws("a", "active"), ws("b", "active"), ws("c", "active")], "home");
    expect(plan).toEqual({ select: "a", mount: ["b", "c"], done: ["a", "b", "c"] });
  });

  it("waits while creating or failed (a retry may still succeed), and forgets one that is gone or archived", () => {
    const pending = new Map<string, string | null>([["a", null], ["b", null], ["c", null], ["d", null]]);
    const plan = openWhenProvisioned(pending, [ws("a", "creating"), ws("b", "create_failed"), ws("d", "archived")], null);
    expect(plan).toEqual({ select: null, mount: [], done: ["c", "d"] });
  });

  it("selects nothing once you moved to another workstream", () => {
    const plan = openWhenProvisioned(new Map([["a", "home"]]), [ws("a", "active")], "elsewhere");
    expect(plan).toEqual({ select: null, mount: ["a"], done: ["a"] });
  });
});
