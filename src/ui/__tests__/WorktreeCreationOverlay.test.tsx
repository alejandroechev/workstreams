import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { WorktreeCreationOverlay } from "../WorktreeCreationOverlay";

// Capture the listener so we can drive synthetic worktree-progress events.
const listeners: Array<(event: { payload: { step: string; detail: string } }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (event: { payload: { step: string; detail: string } }) => void) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }),
}));

function emit(step: string, detail = "") {
  for (const cb of listeners) cb({ payload: { step, detail } });
}

afterEach(() => {
  cleanup();
  listeners.length = 0;
});

describe("WorktreeCreationOverlay", () => {
  it("renders nothing when closed", () => {
    render(<WorktreeCreationOverlay open={false} title="x" />);
    expect(screen.queryByTestId("worktree-creation-overlay")).toBeNull();
  });

  it("renders title + spinner when open", () => {
    render(<WorktreeCreationOverlay open title="Creating workstream…" />);
    expect(screen.getByTestId("worktree-creation-overlay")).toBeTruthy();
    expect(screen.getByText(/Creating workstream/)).toBeTruthy();
    expect(screen.getByText("Starting…")).toBeTruthy();
  });

  it("appends a step row when worktree-progress fires", async () => {
    render(<WorktreeCreationOverlay open title="x" />);
    // Wait for the listener to register.
    await waitFor(() => expect(listeners.length).toBe(1));
    emit("pulling-base", "Pulling latest main from origin");
    await waitFor(() => expect(screen.queryByText("Starting…")).toBeNull());
    expect(screen.getByText(/Pulling latest base branch/)).toBeTruthy();
    expect(screen.getByText(/Pulling latest main from origin/)).toBeTruthy();
  });

  it("renders an unmapped step label as its raw key", async () => {
    render(<WorktreeCreationOverlay open title="x" />);
    await waitFor(() => expect(listeners.length).toBe(1));
    emit("custom-step", "");
    await waitFor(() => expect(screen.getByText("custom-step")).toBeTruthy());
  });

  it("dedupes consecutive identical step events", async () => {
    render(<WorktreeCreationOverlay open title="x" />);
    await waitFor(() => expect(listeners.length).toBe(1));
    emit("creating", "first");
    emit("creating", "second"); // same step → collapsed
    await waitFor(() => expect(screen.getByText(/first/)).toBeTruthy());
    expect(screen.queryByText(/second/)).toBeNull();
  });

  it("shows the offline warning when the last step is pull-skipped", async () => {
    render(<WorktreeCreationOverlay open title="x" />);
    await waitFor(() => expect(listeners.length).toBe(1));
    emit("pull-skipped", "local main diverged from origin/main");
    await waitFor(() =>
      expect(screen.getByText(/Base pull was skipped/)).toBeTruthy(),
    );
  });

  it("resets the step list when toggled closed/open again", async () => {
    const { rerender } = render(<WorktreeCreationOverlay open title="x" />);
    await waitFor(() => expect(listeners.length).toBe(1));
    emit("creating", "first run");
    await waitFor(() => expect(screen.getByText(/first run/)).toBeTruthy());
    rerender(<WorktreeCreationOverlay open={false} title="x" />);
    expect(screen.queryByTestId("worktree-creation-overlay")).toBeNull();
    rerender(<WorktreeCreationOverlay open title="x" />);
    expect(screen.getByText("Starting…")).toBeTruthy();
  });
});
