import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkstreamActionMenu } from "../WorkstreamActionMenu";
import type { Workstream } from "../../domain/types";

const now = new Date().toISOString();
const baseWs: Workstream = {
  id: "ws-1",
  name: "Demo",
  description: null,
  directory: "C:\\repo",
  git_repo: null,
  git_branch: null,
  status: "active",
  project_id: null,
  workstream_type: "base_repo",
  worktree_branch: null,
  created_at: now,
  updated_at: now,
};

function renderMenu(overrides: Partial<Parameters<typeof WorkstreamActionMenu>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onRename: vi.fn(),
    onChangeStatus: vi.fn(),
    onChangeWorktree: vi.fn(),
    onFork: vi.fn(),
    onArchive: vi.fn(),
  };
  render(
    <WorkstreamActionMenu
      workstream={baseWs}
      anchor={{ top: 10, left: 10 }}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("WorkstreamActionMenu", () => {
  it("renders all action entries when both fork + change-worktree handlers are provided", () => {
    renderMenu();
    expect(screen.getByTestId("action-rename")).toBeTruthy();
    expect(screen.getByTestId("action-change-worktree")).toBeTruthy();
    expect(screen.getByTestId("action-fork")).toBeTruthy();
    expect(screen.getByTestId("action-archive")).toBeTruthy();
    expect(screen.getByTestId("action-status-active")).toBeTruthy();
    expect(screen.getByTestId("action-status-working")).toBeTruthy();
    expect(screen.getByTestId("action-status-blocked")).toBeTruthy();
    expect(screen.getByTestId("action-status-in_review")).toBeTruthy();
  });

  it("hides fork + change-worktree when handlers are not provided", () => {
    renderMenu({ onFork: undefined, onChangeWorktree: undefined });
    expect(screen.queryByTestId("action-fork")).toBeNull();
    expect(screen.queryByTestId("action-change-worktree")).toBeNull();
  });

  it("marks the current status visually", () => {
    renderMenu({ workstream: { ...baseWs, status: "working" } });
    const active = screen.getByTestId("action-status-active");
    const working = screen.getByTestId("action-status-working");
    expect(active.style.background).toBe("transparent");
    expect(working.style.background).toBe("rgb(49, 50, 68)");
  });

  it("fires Rename + Close on click", () => {
    const handlers = renderMenu();
    fireEvent.click(screen.getByTestId("action-rename"));
    expect(handlers.onRename).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("fires Archive + Close on click", () => {
    const handlers = renderMenu();
    fireEvent.click(screen.getByTestId("action-archive"));
    expect(handlers.onArchive).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("dispatches the chosen status to onChangeStatus", () => {
    const handlers = renderMenu();
    fireEvent.click(screen.getByTestId("action-status-in_review"));
    expect(handlers.onChangeStatus).toHaveBeenCalledWith("in_review");
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    const handlers = renderMenu();
    // Wait for the deferred listener install.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        fireEvent.keyDown(document, { key: "Escape" });
        expect(handlers.onClose).toHaveBeenCalled();
        resolve();
      }, 5);
    });
  });
});
