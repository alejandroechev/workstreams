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
      onReorderWorkstreams={vi.fn()}
      onChangeStatus={vi.fn()}
      {...over}
    />,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("WorkstreamSidebar status sections", () => {
  it("splits workstreams into Live and Idle by what is loaded", () => {
    renderSidebar([mkWs("a"), mkWs("b"), mkWs("c")], new Set(["a"]));

    expect(screen.getByTestId("ws-section-count-live")).toHaveTextContent("1");
    expect(screen.getByTestId("ws-section-count-idle")).toHaveTextContent("2");
  });

  it("shows live rows immediately", () => {
    renderSidebar([mkWs("a"), mkWs("b")], new Set(["a"]));

    const live = screen.getByTestId("ws-section-live");
    expect(within(live).getByText("a")).toBeInTheDocument();
  });

  it("collapses Idle while there is live work, to stop it crowding the list", () => {
    renderSidebar([mkWs("a"), mkWs("b")], new Set(["a"]));

    expect(screen.queryByText("b")).not.toBeInTheDocument();
  });

  it("EXPANDS Idle when nothing is loaded, so a cold start is never empty", () => {
    // Regression: bucketing everything as idle and defaulting idle to collapsed
    // hid the entire workstream list on launch.
    renderSidebar([mkWs("a"), mkWs("b")], new Set());

    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("is never empty when loadedWsIds is not supplied at all", () => {
    renderSidebar([mkWs("a")]);

    expect(screen.getByText("a")).toBeInTheDocument();
  });

  it("toggling a section reveals its rows and persists the choice", () => {
    const { unmount } = renderSidebar([mkWs("a"), mkWs("b")], new Set(["a"]));
    expect(screen.queryByText("b")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("ws-section-toggle-idle"));
    expect(screen.getByText("b")).toBeInTheDocument();

    unmount();
    renderSidebar([mkWs("a"), mkWs("b")], new Set(["a"]));
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("keeps archived workstreams out of both working sections", () => {
    renderSidebar([mkWs("a"), mkWs("z", { status: "archived" })], new Set(["a"]));

    expect(screen.getByTestId("ws-section-count-live")).toHaveTextContent("1");
    expect(screen.getByTestId("ws-section-count-idle")).toHaveTextContent("0");
  });

  it("keeps a workstream whose worktree is being created in the working list", () => {
    renderSidebar([mkWs("new", { status: "creating" })], new Set());

    expect(screen.getByText("new")).toBeInTheDocument();
  });
});

describe("WorkstreamSidebar repo footer", () => {
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
