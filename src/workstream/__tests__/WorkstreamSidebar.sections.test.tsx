import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen, within } from "@testing-library/react";
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

const mkProject = (id: string, name: string): Project => ({
  id,
  name,
  directory: `/repos/${name}`,
  git_remote: null,
  color: "#89b4fa",
  copilot_command: null,
  created_at: now,
  updated_at: now,
});

function renderSidebar(
  workstreams: Workstream[],
  loadedWsIds?: Set<string>,
  over: Partial<React.ComponentProps<typeof WorkstreamSidebar>> = {},
) {
  return render(
    <WorkstreamSidebar
      projects={[mkProject("p1", "App")]}
      workstreams={workstreams}
      loadedWsIds={loadedWsIds}
      activeWsId={null}
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      onChangeStatus={vi.fn()}
      {...over}
    />,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("WorkstreamSidebar unified list", () => {
  it("shows every non-archived workstream by default, whatever is loaded", () => {
    // The old Live/Idle split hid unloaded rows behind a collapsed section.
    renderSidebar([mkWs("a"), mkWs("b"), mkWs("c")], new Set(["a"]));

    for (const name of ["a", "b", "c"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("puts unfiled workstreams in a No lane group", () => {
    renderSidebar([mkWs("a")], new Set());

    const unfiled = screen.getByTestId("ws-lane-__no_lane__");
    expect(within(unfiled).getByText("a")).toBeInTheDocument();
  });

  it("nests workstreams under their lane", () => {
    renderSidebar([mkWs("a", { lane_id: "l1" }), mkWs("b")], new Set(), {
      lanes: [{ id: "l1", name: "Media Store" }],
    });

    const lane = screen.getByTestId("ws-lane-l1");
    expect(within(lane).getByText("a")).toBeInTheDocument();
    expect(within(lane).queryByText("b")).not.toBeInTheDocument();
    expect(screen.getByText("Media Store")).toBeInTheDocument();
  });

  /**
   * "No lane" is the drop target for taking a workstream *out* of a lane, so it
   * cannot disappear when every workstream happens to be filed.
   */
  it("keeps the No lane group even when it is empty", () => {
    renderSidebar([mkWs("a", { lane_id: "l1" })], new Set(), {
      lanes: [{ id: "l1", name: "Media Store" }],
    });

    expect(screen.getByTestId("ws-lane-__no_lane__")).toBeInTheDocument();
  });

  it("collapses a lane and persists the choice", () => {
    renderSidebar([mkWs("a", { lane_id: "l1" })], new Set(), {
      lanes: [{ id: "l1", name: "Media Store" }],
    });

    expect(screen.getByText("a")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ws-lane-toggle-l1"));
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    expect(localStorage.getItem("ws-sidebar-collapsed-sections")).toContain("l1");
  });

  it("filters to loaded workstreams only", () => {
    renderSidebar([mkWs("a"), mkWs("b")], new Set(["a"]));

    fireEvent.click(screen.getByTestId("ws-list-filter-loaded"));
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.queryByText("b")).not.toBeInTheDocument();
  });

  it("hides archived until the All filter, then shows them dimmed", () => {
    renderSidebar([mkWs("a"), mkWs("b", { status: "archived" })], new Set());

    expect(screen.queryByText("b")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("ws-list-filter-all"));
    expect(screen.getByText("b")).toBeInTheDocument();
    const archived = screen
      .getAllByTestId("workstream-item")
      .find((row) => row.getAttribute("data-workstream-id") === "b");
    expect(archived).toHaveAttribute("data-archived", "true");
  });

  it("reports how many rows a filter is hiding", () => {
    renderSidebar([mkWs("a"), mkWs("b", { status: "archived" })], new Set());

    expect(screen.getByTestId("ws-lane-hidden-__no_lane__")).toHaveTextContent("1 hidden");
  });

  /**
   * `create_failed` has no other signal in the UI, so a filter that hid it
   * would make a broken workstream silently vanish.
   */
  it("never hides a failed creation, even under the narrowest filter", () => {
    renderSidebar([mkWs("a"), mkWs("broken", { status: "create_failed" })], new Set());

    fireEvent.click(screen.getByTestId("ws-list-filter-loaded"));
    expect(screen.getByText("broken")).toBeInTheDocument();
    expect(screen.queryByText("a")).not.toBeInTheDocument();
  });

  it("keeps a workstream whose worktree is being created visible", () => {
    renderSidebar([mkWs("a", { status: "creating" })], new Set());

    expect(screen.getByText("a")).toBeInTheDocument();
  });

  it("replaces the repo list with a single footer control", () => {
    renderSidebar([mkWs("a")], new Set(["a"]));

    const footer = screen.getByTestId("repo-manager-button");
    expect(footer).toHaveTextContent("1 repo");
    // The old always-visible repo list is gone from the sidebar body.
    expect(screen.queryByTestId("repo-manager-panel")).not.toBeInTheDocument();
  });

  it("opens the Repo Manager and closes it again", () => {
    renderSidebar([mkWs("a")], new Set(["a"]));

    fireEvent.click(screen.getByTestId("repo-manager-button"));
    expect(screen.getByTestId("repo-manager-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("repo-manager-close"));
    expect(screen.queryByTestId("repo-manager-panel")).not.toBeInTheDocument();
  });

  it("counts repos with no active workstreams as dormant", () => {
    renderSidebar([mkWs("a", { project_id: null })], new Set(["a"]));

    expect(screen.getByTestId("repo-dormant-count")).toHaveTextContent("1 dormant");
  });

  it("does not call a repo dormant when it has active work", () => {
    renderSidebar([mkWs("a", { project_id: "p1" })], new Set(["a"]));

    expect(screen.queryByTestId("repo-dormant-count")).not.toBeInTheDocument();
  });

  it("routes import and create through the manager", () => {
    const onImportProject = vi.fn();
    const onCreateProject = vi.fn();
    renderSidebar([mkWs("a")], new Set(["a"]), { onImportProject, onCreateProject });

    fireEvent.click(screen.getByTestId("repo-manager-button"));
    fireEvent.click(screen.getByTestId("repo-manager-import"));
    expect(onImportProject).toHaveBeenCalled();
    // Choosing an action dismisses the manager so the flow it opens is visible.
    expect(screen.queryByTestId("repo-manager-panel")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("repo-manager-button"));
    fireEvent.click(screen.getByTestId("repo-manager-create"));
    expect(onCreateProject).toHaveBeenCalled();
  });
});
