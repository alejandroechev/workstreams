import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, cleanup } from "@testing-library/react";
import WorkstreamSidebar from "../WorkstreamSidebar";
import type { Workstream } from "../../domain/types";
import type { LoopSummary } from "../../domain/loop";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const now = new Date().toISOString();
const mk = (id: string, name: string): Workstream => ({
  id,
  name,
  description: null,
  directory: `C:\\repos\\${id}`,
  git_repo: null,
  git_branch: null,
  status: "active",
  project_id: null,
  workstream_type: "base_repo",
  worktree_branch: null,
  created_at: now,
  updated_at: now,
});

function renderWith(
  loadedWsIds?: Set<string>,
  activeWsId: string | null = "a",
  loopSummaries: LoopSummary[] = [],
) {
  return render(
    <WorkstreamSidebar
      projects={[]}
      workstreams={[mk("a", "Alpha"), mk("b", "Beta")]}
      activeWsId={activeWsId}
      loadedWsIds={loadedWsIds}
      loopSummaries={loopSummaries}
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      onReorderWorkstreams={vi.fn()}
      onChangeStatus={vi.fn()}
    />,
  );
}

describe("WorkstreamSidebar activity indicator", () => {
  it("renders idle indicators when loadedWsIds is omitted (back-compat)", () => {
    const { getAllByTestId, queryAllByTestId } = renderWith(undefined);
    expect(getAllByTestId("ws-indicator-idle").length).toBeGreaterThanOrEqual(2);
    expect(queryAllByTestId("ws-indicator-stopped")).toHaveLength(0);
    cleanup();
  });

  it("renders stopped indicator for workstreams not in loadedWsIds", () => {
    const { getAllByTestId, queryAllByTestId, getByTestId } = renderWith(new Set(["a"]));
    // Unloaded workstreams now live in the Idle section, which auto-collapses
    // while something is live. Expand it to assert on the row itself.
    fireEvent.click(getByTestId("ws-section-toggle-idle"));
    expect(getAllByTestId("ws-indicator-stopped")).toHaveLength(1);
    expect(queryAllByTestId("ws-indicator-idle").length).toBeGreaterThanOrEqual(1);
    cleanup();
  });

  it("raises the bell indicator on workstream-bell CustomEvent for an unfocused workstream", () => {
    // 'a' is active, 'b' should react to the bell event.
    const { findByTestId, queryByTestId } = renderWith(new Set(["a", "b"]), "a");
    act(() => {
      window.dispatchEvent(new CustomEvent("workstream-bell", { detail: { workstreamId: "b" } }));
    });
    return findByTestId("ws-indicator-bell").then((bell) => {
      expect(bell).toBeTruthy();
      // 'a' (active) should NOT have a bell even if event was dispatched for it.
      act(() => {
        window.dispatchEvent(new CustomEvent("workstream-bell", { detail: { workstreamId: "a" } }));
      });
      const bells = document.querySelectorAll('[data-testid="ws-indicator-bell"]');
      expect(bells.length).toBe(1);
      expect(queryByTestId).toBeDefined();
      cleanup();
    });
  });

  it("surfaces per-workstream loop state and the running total", () => {
    const { getByTestId, queryByTestId } = renderWith(
      new Set(["a", "b"]),
      "a",
      [
        {
          workstreamId: "a",
          loopSpecId: "spec-a",
          enabled: true,
          runId: "run-a",
          runState: "working",
        },
        {
          workstreamId: "b",
          loopSpecId: "spec-b",
          enabled: true,
          runId: "run-b",
          runState: "attention",
        },
      ],
    );

    expect(getByTestId("running-loop-count").textContent).toContain("1 running");
    expect(getByTestId("ws-loop-running-a")).toBeTruthy();
    expect(getByTestId("ws-loop-attention-b")).toBeTruthy();
    expect(queryByTestId("ws-loop-running-b")).toBeNull();
    cleanup();
  });
});
