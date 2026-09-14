import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import WorkstreamSidebar from "../WorkstreamSidebar";
import type { Project, Workstream } from "../../domain/types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const now = new Date().toISOString();

const mkWs = (id: string, over: Partial<Workstream> = {}): Workstream => ({
  id,
  name: id,
  description: null,
  directory: null,
  git_repo: null,
  git_branch: null,
  status: "active",
  project_id: null,
  workstream_type: "standalone",
  worktree_branch: null,
  created_at: now,
  updated_at: now,
  ...over,
});

const project: Project = {
  id: "p1",
  name: "App",
  directory: "/repos/app",
  git_remote: null,
  color: "#89b4fa",
  copilot_command: null,
  created_at: now,
  updated_at: now,
};

function renderSidebar(
  workstreams: Workstream[],
  over: Partial<React.ComponentProps<typeof WorkstreamSidebar>> = {},
) {
  const onAssignLane = vi.fn();
  render(
    <WorkstreamSidebar
      projects={[project]}
      workstreams={workstreams}
      loadedWsIds={new Set()}
      activeWsId={null}
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      onChangeStatus={vi.fn()}
      onAssignLane={onAssignLane}
      {...over}
    />,
  );
  return { onAssignLane };
}

/** jsdom has no drag implementation, so the events are driven directly. */
function dragRowOnto(workstreamId: string, laneTestId: string) {
  const row = screen
    .getAllByTestId("workstream-item")
    .find((node) => node.getAttribute("data-workstream-id") === workstreamId);
  if (!row) throw new Error(`no row for ${workstreamId}`);
  const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
  fireEvent.dragStart(row, { dataTransfer });
  const lane = screen.getByTestId(laneTestId);
  fireEvent.dragOver(lane, { dataTransfer });
  fireEvent.drop(lane, { dataTransfer });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("archive cleanup in the unified list", () => {
  /**
   * Regression: merging the archived section into the main list dropped the
   * removal warning and its Retry, leaving a failed worktree deletion with no
   * visible signal and no recovery.
   */
  it("shows a failed worktree removal and offers a retry", () => {
    const onRetryRemove = vi.fn();
    render(
      <WorkstreamSidebar
        projects={[project]}
        workstreams={[mkWs("a", { status: "archived" })]}
        loadedWsIds={new Set()}
        activeWsId={null}
        onSelectWorkstream={vi.fn()}
        onCreateProject={vi.fn()}
        onImportProject={vi.fn()}
        onCreateWorkstream={vi.fn()}
        onArchiveWorkstream={vi.fn()}
        onRenameWorkstream={vi.fn()}
        onUpdateProject={vi.fn()}
        onChangeStatus={vi.fn()}
        onRetryRemove={onRetryRemove}
        provisioning={
          new Map([["a", { op: "archive", phase: "remove-failed", warning: "git said no" }]]) as never
        }
      />,
    );

    // Archived rows are hidden by default.
    fireEvent.click(screen.getByTestId("ws-list-filter-all"));
    expect(screen.getByTestId("ws-remove-warning-a")).toHaveTextContent("git said no");
    fireEvent.click(screen.getByTestId("ws-retry-remove-a"));
    expect(onRetryRemove).toHaveBeenCalledWith("a");
  });

  it("shows cleanup progress while a worktree is being removed", () => {
    render(
      <WorkstreamSidebar
        projects={[project]}
        workstreams={[mkWs("a", { status: "archiving" })]}
        loadedWsIds={new Set()}
        activeWsId={null}
        onSelectWorkstream={vi.fn()}
        onCreateProject={vi.fn()}
        onImportProject={vi.fn()}
        onCreateWorkstream={vi.fn()}
        onArchiveWorkstream={vi.fn()}
        onRenameWorkstream={vi.fn()}
        onUpdateProject={vi.fn()}
        onChangeStatus={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("ws-list-filter-all"));
    expect(screen.getByTestId("ws-archiving-a")).toBeInTheDocument();
  });
});

describe("lane header layout", () => {
  const renderLanes = (lanes: { id: string; name: string }[]) =>
    render(
      <WorkstreamSidebar
        projects={[project]}
        workstreams={[mkWs("a", { lane_id: lanes[0]?.id })]}
        loadedWsIds={new Set()}
        activeWsId={null}
        onSelectWorkstream={vi.fn()}
        onCreateProject={vi.fn()}
        onImportProject={vi.fn()}
        onCreateWorkstream={vi.fn()}
        onArchiveWorkstream={vi.fn()}
        onRenameWorkstream={vi.fn()}
        onUpdateProject={vi.fn()}
        onChangeStatus={vi.fn()}
        lanes={lanes}
        onDeleteLane={vi.fn()}
      />,
    );

  /**
   * The toggle is `width: 100%`, so as a plain sibling the delete button
   * wrapped onto its own line. They must share a row.
   */
  it("keeps the delete button on the same row as the lane name", () => {
    renderLanes([{ id: "l1", name: "Media Store" }]);

    const toggle = screen.getByTestId("ws-lane-toggle-l1");
    const remove = screen.getByTestId("ws-lane-delete-l1");
    expect(remove.parentElement).toBe(toggle.parentElement);
    expect(toggle.parentElement).toHaveStyle({ display: "flex" });
  });

  it("gives each lane its own accent colour, and No lane a neutral one", () => {
    renderLanes([
      { id: "l1", name: "Media Store" },
      { id: "l2", name: "Tooling" },
    ]);

    const borderOf = (key: string) =>
      screen.getByTestId(`ws-lane-${key}`).style.borderLeftColor;

    // Two lanes must not be the same colour, or the accent tells you nothing.
    expect(borderOf("l1")).not.toBe(borderOf("l2"));
    expect(borderOf("l1")).toBeTruthy();
    // The unfiled group is deliberately grey rather than a palette colour.
    expect(borderOf("__no_lane__")).not.toBe(borderOf("l1"));
  });

  it("does not offer to delete the No lane group", () => {
    renderLanes([{ id: "l1", name: "Media Store" }]);

    expect(screen.queryByTestId("ws-lane-delete-__no_lane__")).toBeNull();
  });
});

describe("creating a lane", () => {
  /**
   * The bug this encodes: the button used `window.prompt`, which WKWebView --
   * and therefore the packaged app -- does not implement. jsdom and Chromium
   * both provide it, so neither the unit tests nor the Playwright suite could
   * see the failure; only the real app could.
   *
   * Deleting it here models the host we actually ship on.
   */
  it("works without window.prompt, which the Tauri webview does not implement", () => {
    const original = window.prompt;
    // @ts-expect-error -- modelling a host that has no prompt at all.
    delete window.prompt;
    const onCreateLane = vi.fn();
    try {
      render(
        <WorkstreamSidebar
          projects={[project]}
          workstreams={[mkWs("a")]}
          loadedWsIds={new Set()}
          activeWsId={null}
          onSelectWorkstream={vi.fn()}
          onCreateProject={vi.fn()}
          onImportProject={vi.fn()}
          onCreateWorkstream={vi.fn()}
          onArchiveWorkstream={vi.fn()}
          onRenameWorkstream={vi.fn()}
          onUpdateProject={vi.fn()}
          onChangeStatus={vi.fn()}
          onCreateLane={onCreateLane}
        />,
      );

      fireEvent.click(screen.getByTestId("ws-add-lane"));
      const input = screen.getByTestId("ws-new-lane-input");
      fireEvent.change(input, { target: { value: "  Media Store  " } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onCreateLane).toHaveBeenCalledWith("Media Store");
    } finally {
      window.prompt = original;
    }
  });

  it("abandons the new lane on Escape", () => {
    const onCreateLane = vi.fn();
    render(
      <WorkstreamSidebar
        projects={[project]}
        workstreams={[mkWs("a")]}
        loadedWsIds={new Set()}
        activeWsId={null}
        onSelectWorkstream={vi.fn()}
        onCreateProject={vi.fn()}
        onImportProject={vi.fn()}
        onCreateWorkstream={vi.fn()}
        onArchiveWorkstream={vi.fn()}
        onRenameWorkstream={vi.fn()}
        onUpdateProject={vi.fn()}
        onChangeStatus={vi.fn()}
        onCreateLane={onCreateLane}
      />,
    );

    fireEvent.click(screen.getByTestId("ws-add-lane"));
    const input = screen.getByTestId("ws-new-lane-input");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onCreateLane).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ws-new-lane-input")).toBeNull();
  });

  it("ignores an empty name", () => {
    const onCreateLane = vi.fn();
    render(
      <WorkstreamSidebar
        projects={[project]}
        workstreams={[mkWs("a")]}
        loadedWsIds={new Set()}
        activeWsId={null}
        onSelectWorkstream={vi.fn()}
        onCreateProject={vi.fn()}
        onImportProject={vi.fn()}
        onCreateWorkstream={vi.fn()}
        onArchiveWorkstream={vi.fn()}
        onRenameWorkstream={vi.fn()}
        onUpdateProject={vi.fn()}
        onChangeStatus={vi.fn()}
        onCreateLane={onCreateLane}
      />,
    );

    fireEvent.click(screen.getByTestId("ws-add-lane"));
    const input = screen.getByTestId("ws-new-lane-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreateLane).not.toHaveBeenCalled();
  });
});

describe("assigning lanes by drag", () => {
  const lanes = [
    { id: "l1", name: "Media Store" },
    { id: "l2", name: "Tooling" },
  ];

  it("dropping a workstream on a lane assigns it there", () => {
    const { onAssignLane } = renderSidebar([mkWs("a")], { lanes });

    dragRowOnto("a", "ws-lane-l1");
    expect(onAssignLane).toHaveBeenCalledWith("a", "l1");
  });

  it("dropping on another lane moves it", () => {
    const { onAssignLane } = renderSidebar([mkWs("a", { lane_id: "l1" })], { lanes });

    dragRowOnto("a", "ws-lane-l2");
    expect(onAssignLane).toHaveBeenCalledWith("a", "l2");
  });

  /**
   * The inverse gesture. Without a droppable "No lane" the interaction would be
   * asymmetric — draggable in, menu out — which is why that group renders even
   * when empty.
   */
  it("dropping on No lane takes a workstream out of its lane", () => {
    const { onAssignLane } = renderSidebar([mkWs("a", { lane_id: "l1" })], { lanes });

    dragRowOnto("a", "ws-lane-__no_lane__");
    expect(onAssignLane).toHaveBeenCalledWith("a", null);
  });

  it("does nothing when no lane handler is supplied", () => {
    renderSidebar([mkWs("a")], { lanes, onAssignLane: undefined });

    // The whole point is that this must not throw.
    expect(() => dragRowOnto("a", "ws-lane-l1")).not.toThrow();
  });

  /**
   * Manual ordering is gone, so a drop on a row is not a reorder. Rather than
   * doing nothing -- which reads as broken -- the event bubbles to the
   * enclosing lane, so dropping beside a lane's members joins that lane.
   */
  it("dropping onto a row joins the lane that row is in", () => {
    const { onAssignLane } = renderSidebar(
      [mkWs("a"), mkWs("b", { lane_id: "l2" })],
      { lanes },
    );

    const target = screen
      .getAllByTestId("workstream-item")
      .find((node) => node.getAttribute("data-workstream-id") === "b");
    const source = screen
      .getAllByTestId("workstream-item")
      .find((node) => node.getAttribute("data-workstream-id") === "a");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(source!, { dataTransfer });
    fireEvent.dragOver(target!, { dataTransfer });
    fireEvent.drop(target!, { dataTransfer });

    expect(onAssignLane).toHaveBeenCalledWith("a", "l2");
  });

  it("dropping a workstream on the lane it is already in is harmless", () => {
    const { onAssignLane } = renderSidebar([mkWs("a", { lane_id: "l1" })], { lanes });

    dragRowOnto("a", "ws-lane-l1");
    expect(onAssignLane).toHaveBeenCalledWith("a", "l1");
  });
});
