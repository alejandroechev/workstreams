import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  });

  it("hides fork + change-worktree when handlers are not provided", () => {
    renderMenu({ onFork: undefined, onChangeWorktree: undefined });
    expect(screen.queryByTestId("action-fork")).toBeNull();
    expect(screen.queryByTestId("action-change-worktree")).toBeNull();
  });

  it("does not surface status options (status UI removed)", () => {
    renderMenu();
    expect(screen.queryByTestId("action-status-active")).toBeNull();
    expect(screen.queryByTestId("action-status-working")).toBeNull();
    expect(screen.queryByTestId("action-status-in_review")).toBeNull();
    expect(screen.queryByTestId("action-status-blocked")).toBeNull();
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

  it("surfaces the Close item only when the workstream is loaded", () => {
    // Not loaded → no Close item.
    const { unmount } = render(
      <WorkstreamActionMenu
        workstream={baseWs}
        anchor={{ top: 10, left: 10 }}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onCloseWorkstream={vi.fn()}
        isLoaded={false}
      />,
    );
    expect(screen.queryByTestId("action-close")).toBeNull();
    unmount();

    // Loaded → Close item present.
    renderMenu({ isLoaded: true, onCloseWorkstream: vi.fn() });
    expect(screen.getByTestId("action-close")).toBeTruthy();
  });

  it("hides the Close item when no onCloseWorkstream handler is provided", () => {
    renderMenu({ isLoaded: true });
    expect(screen.queryByTestId("action-close")).toBeNull();
  });

  it("fires Close-workstream + menu Close on click", () => {
    const onCloseWorkstream = vi.fn();
    const handlers = renderMenu({ isLoaded: true, onCloseWorkstream });
    fireEvent.click(screen.getByTestId("action-close"));
    expect(onCloseWorkstream).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("stops action clicks from bubbling to an ancestor (row select) handler", () => {
    const onAncestorClick = vi.fn();
    const handlers = {
      onClose: vi.fn(),
      onRename: vi.fn(),
      onChangeStatus: vi.fn(),
      onChangeWorktree: vi.fn(),
      onFork: vi.fn(),
      onArchive: vi.fn(),
    };
    render(
      <div onClick={onAncestorClick} data-testid="row">
        <WorkstreamActionMenu
          workstream={baseWs}
          anchor={{ top: 10, left: 10 }}
          {...handlers}
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId("action-archive"));
    expect(handlers.onArchive).toHaveBeenCalledOnce();
    // The row's select handler must NOT fire — invoking an action on a
    // non-loaded workstream should not open/load it.
    expect(onAncestorClick).not.toHaveBeenCalled();
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

describe("closing by clicking elsewhere", () => {
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("closes even when the clicked element stops the event (a terminal)", async () => {
    const terminal = document.createElement("div");
    terminal.addEventListener("mousedown", (e) => e.stopPropagation());
    document.body.appendChild(terminal);
    const handlers = renderMenu();
    await settle();
    fireEvent.mouseDown(terminal);
    expect(handlers.onClose).toHaveBeenCalled();
    terminal.remove();
  });

  it("closes when the window loses focus (a click into an embedded frame)", async () => {
    const handlers = renderMenu();
    await settle();
    fireEvent.blur(window);
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it("leaves a click on its own trigger to the trigger, so it toggles closed", async () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-action-menu-trigger", "");
    document.body.appendChild(trigger);
    const handlers = renderMenu();
    await settle();
    fireEvent.mouseDown(trigger);
    expect(handlers.onClose).not.toHaveBeenCalled();
    trigger.remove();
  });
});

describe("create task action", () => {
  it("offers Create task when a handler is supplied", () => {
    renderMenu({ onCreateTask: vi.fn() });
    expect(screen.getByTestId("action-create-task")).toBeTruthy();
  });

  it("invokes the handler and closes the menu", () => {
    const onCreateTask = vi.fn();
    const handlers = renderMenu({ onCreateTask });

    fireEvent.click(screen.getByTestId("action-create-task"));

    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it("hides the action when no handler is supplied", () => {
    renderMenu();
    expect(screen.queryByTestId("action-create-task")).toBeNull();
  });
});

describe("bound workstreams offer Go to task instead of Create task", () => {
  it("offers Go to task when the workstream already has one", () => {
    renderMenu({ onCreateTask: vi.fn(), onGoToTask: vi.fn() });
    expect(screen.getByTestId("action-go-to-task")).toBeTruthy();
  });

  it("hides Create task once bound, because the relation is 1:1", () => {
    renderMenu({ onCreateTask: vi.fn(), onGoToTask: vi.fn() });
    expect(screen.queryByTestId("action-create-task")).toBeNull();
  });

  it("still offers Create task while unbound", () => {
    renderMenu({ onCreateTask: vi.fn() });
    expect(screen.getByTestId("action-create-task")).toBeTruthy();
    expect(screen.queryByTestId("action-go-to-task")).toBeNull();
  });

  it("invokes the handler and closes the menu", () => {
    const onGoToTask = vi.fn();
    const handlers = renderMenu({ onCreateTask: vi.fn(), onGoToTask });
    fireEvent.click(screen.getByTestId("action-go-to-task"));
    expect(onGoToTask).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it("moves up and left to stay inside the window when opened near its bottom-right", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 220, height: 300, top: 0, left: 0, right: 220, bottom: 300, toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    renderMenu({ anchor: { top: 550, left: 700 } });
    const menu = screen.getByTestId("workstream-action-menu");
    await waitFor(() => expect(menu.style.top).toBe("292px"));
    expect(menu.style.left).toBe("572px");
    rect.mockRestore();
  });

  it("keeps its anchor when it already fits", () => {
    renderMenu({ anchor: { top: 40, left: 30 } });
    const menu = screen.getByTestId("workstream-action-menu");
    expect(menu.style.top).toBe("40px");
    expect(menu.style.left).toBe("30px");
  });
});
