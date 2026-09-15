import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import WorkstreamSidebar from "../WorkstreamSidebar";
import type { Project, Workstream } from "../../domain/types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

function project(id: string, name: string): Project {
  return {
    id,
    name,
    directory: `/Code/${name}`,
    git_remote: null,
    color: "#89b4fa",
    copilot_command: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function ws(id: string): Workstream {
  return {
    id,
    name: id,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: "p1",
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function renderSidebar(over: Record<string, unknown> = {}) {
  return render(
    <WorkstreamSidebar
      projects={[project("p1", "waimea")]}
      workstreams={[ws("w1")]}
      activeWsId={null}
      onChangeStatus={vi.fn()}
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      {...over}
    />,
  );
}

describe("WorkstreamSidebar task board entry point", () => {
  it("offers a Tasks button in the footer", () => {
    renderSidebar({ onOpenTaskBoard: vi.fn() });
    expect(screen.getByTestId("task-board-button")).toBeInTheDocument();
  });

  it("actually invokes the handler when clicked", () => {
    // A button that renders but never fires is the exact failure mode that
    // shipped twice in the sidebar prototypes -- assert the wiring, not just
    // the markup.
    const onOpenTaskBoard = vi.fn();
    renderSidebar({ onOpenTaskBoard });
    fireEvent.click(screen.getByTestId("task-board-button"));
    expect(onOpenTaskBoard).toHaveBeenCalledTimes(1);
  });

  /**
   * Was "stays renderable when no handler is supplied" -- a button that
   * rendered and did nothing. The task board is now sunset behind a feature
   * flag, and App.tsx withholds the handler when it is off, so the absence of
   * a handler is how the whole section is hidden. A dead Tasks button in a
   * build with no task board is worse than no button.
   */
  it("hides the whole Tasks section when no handler is supplied", () => {
    renderSidebar({ onOpenTaskBoard: undefined });
    expect(screen.queryByTestId("task-board-button")).not.toBeInTheDocument();
  });

  it("hides the in-progress miniview along with the button", () => {
    // The miniview is passed as a node; withholding the handler must not leave
    // it stranded in the footer with nothing to open.
    renderSidebar({
      onOpenTaskBoard: undefined,
      inProgressTasks: <div data-testid="mini-view">in progress</div>,
    });
    expect(screen.queryByTestId("mini-view")).not.toBeInTheDocument();
  });
});
