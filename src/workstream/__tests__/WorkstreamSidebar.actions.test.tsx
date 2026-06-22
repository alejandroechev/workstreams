import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import WorkstreamSidebar from "../WorkstreamSidebar";
import type { Workstream } from "../../domain/types";

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

function renderWith(handlers: Partial<React.ComponentProps<typeof WorkstreamSidebar>> = {}) {
  return render(
    <WorkstreamSidebar
      projects={[]}
      workstreams={[mk("a", "Alpha"), mk("b", "Beta")]}
      activeWsId="a"
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      onReorderWorkstreams={vi.fn()}
      onChangeStatus={vi.fn()}
      {...handlers}
    />,
  );
}

describe("WorkstreamSidebar actions menu (non-active workstreams)", () => {
  it("renders the actions button for every workstream, not just the active one", () => {
    const { getByTestId } = renderWith();
    // 'b' is not the active workstream but still has an actions button.
    expect(getByTestId("ws-actions-b")).toBeTruthy();
    expect(getByTestId("ws-actions-a")).toBeTruthy();
    cleanup();
  });

  it("opens the action menu for a non-active workstream without selecting it", () => {
    const onSelectWorkstream = vi.fn();
    const { getByTestId } = renderWith({ onSelectWorkstream });

    fireEvent.click(getByTestId("ws-actions-b"));

    // Clicking the actions button must not select/open the workstream.
    expect(onSelectWorkstream).not.toHaveBeenCalled();
    // The menu is open (archive action is available).
    expect(getByTestId("action-archive")).toBeTruthy();
    cleanup();
  });

  it("archives a non-active workstream from its action menu", () => {
    const onArchiveWorkstream = vi.fn();
    const { getByTestId } = renderWith({ onArchiveWorkstream });

    fireEvent.click(getByTestId("ws-actions-b"));
    fireEvent.click(getByTestId("action-archive"));

    expect(onArchiveWorkstream).toHaveBeenCalledWith("b");
    cleanup();
  });

  it("hides the actions button on inactive rows until hovered", () => {
    const { getByTestId } = renderWith();
    const inactiveBtn = getByTestId("ws-actions-b");
    expect(inactiveBtn.style.visibility).toBe("hidden");

    const row = getByTestId("ws-actions-a"); // active row button is visible
    expect(row.style.visibility).toBe("visible");

    // Hovering the inactive row reveals its button.
    const bRow = document.querySelector('[data-workstream-id="b"]') as HTMLElement;
    fireEvent.mouseEnter(bRow);
    expect(within(bRow).getByTestId("ws-actions-b").style.visibility).toBe("visible");
    cleanup();
  });
});

describe("WorkstreamSidebar workstreams collapse", () => {
  it("hides the workstream list when the header toggle is clicked", () => {
    const { getByTestId, queryByTestId, getAllByTestId } = renderWith();
    // Expanded by default: both workstream rows visible.
    expect(getAllByTestId("workstream-item").length).toBe(2);

    fireEvent.click(getByTestId("workstreams-toggle"));
    expect(queryByTestId("workstream-item")).toBeNull();

    // Toggling again restores the list.
    fireEvent.click(getByTestId("workstreams-toggle"));
    expect(getAllByTestId("workstream-item").length).toBe(2);
    cleanup();
  });
});
