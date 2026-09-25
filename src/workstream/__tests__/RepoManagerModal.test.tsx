import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { RepoManagerModal } from "../RepoManagerModal";
import type { Project, Workstream } from "../../domain/types";

function project(id: string, name: string, over: Partial<Project> = {}): Project {
  return {
    id,
    name,
    directory: `/Code/${name}`,
    git_remote: null,
    color: "#89b4fa",
    copilot_command: null,
    archived: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function ws(id: string, projectId: string | null, status: Workstream["status"] = "active"): Workstream {
  return {
    id,
    name: id,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status,
    project_id: projectId,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const baseProps = {
  projects: [project("p1", "WB"), project("p2", "workstreams")],
  workstreams: [ws("w1", "p1"), ws("w2", "p1"), ws("w3", "p2")],
  onClose: () => {},
  onUpdateProject: () => {},
  onCreateProject: () => {},
  onImportProject: () => {},
};

describe("RepoManagerModal", () => {
  it("offers opt-in for ADO only and reports configuration errors", async () => {
    const configure = vi.fn().mockRejectedValue(new Error("Could not save notifications"));
    render(<RepoManagerModal {...baseProps}
      projects={[project("p1", "ADO", { git_remote: "https://dev.azure.com/o/p/_git/r" }), project("p2", "Local")]}
      inboxRepos={[]} onConfigureInbox={configure} />);
    const mode = screen.getByTestId("repo-inbox-mode");
    expect(mode).toHaveValue("off");
    fireEvent.change(mode, { target: { value: "both" } });
    await waitFor(() => expect(configure).toHaveBeenCalledWith("p1", "both"));
    expect(await screen.findByText("Could not save notifications")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("repo-manager-row-p2"));
    expect(screen.getByTestId("repo-inbox-mode")).toBeDisabled();
  });

  /**
   * The selector is the only place the distinction between "watch my reviews"
   * and "watch what I opened" is expressed, and picking the wrong one silently
   * produces the wrong notifications for days.
   */
  it("reflects the saved watch mode and offers every choice", async () => {
    const configure = vi.fn().mockResolvedValue(undefined);
    render(<RepoManagerModal {...baseProps}
      projects={[project("p1", "ADO", { git_remote: "https://dev.azure.com/o/p/_git/r" })]}
      inboxRepos={[{ project_id: "p1", repo_name: "ADO", enabled: true, mode: "author",
        last_checked: null, error: null }]}
      onConfigureInbox={configure} />);
    const mode = screen.getByTestId("repo-inbox-mode");
    expect(mode).toHaveValue("author");
    expect(within(mode).getAllByRole("option").map((o) => o.getAttribute("value")))
      .toEqual(["off", "reviewer", "author", "both"]);
    fireEvent.change(mode, { target: { value: "off" } });
    await waitFor(() => expect(configure).toHaveBeenCalledWith("p1", "off"));
  });

  it("lists every repo with its active workstream count", () => {
    render(<RepoManagerModal {...baseProps} />);

    expect(within(screen.getByTestId("repo-manager-row-p1")).getByText("2")).toBeInTheDocument();
    expect(within(screen.getByTestId("repo-manager-row-p2")).getByText("1")).toBeInTheDocument();
  });

  it("does not count archived workstreams towards a repo", () => {
    render(
      <RepoManagerModal
        {...baseProps}
        workstreams={[ws("w1", "p1"), ws("w2", "p1", "archived")]}
      />,
    );

    expect(within(screen.getByTestId("repo-manager-row-p1")).getByText("1")).toBeInTheDocument();
  });

  it("marks a repo with no active workstreams as dormant", () => {
    render(<RepoManagerModal {...baseProps} workstreams={[ws("w1", "p1")]} />);

    expect(screen.getByTestId("repo-manager-row-p2")).toHaveAttribute("data-dormant", "true");
    expect(screen.getByTestId("repo-manager-row-p1")).toHaveAttribute("data-dormant", "false");
  });

  it("filters by name and by directory", () => {
    render(<RepoManagerModal {...baseProps} />);
    const search = screen.getByTestId("repo-manager-search");

    fireEvent.change(search, { target: { value: "workstr" } });
    expect(screen.queryByTestId("repo-manager-row-p1")).not.toBeInTheDocument();
    expect(screen.getByTestId("repo-manager-row-p2")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "/Code/WB" } });
    expect(screen.getByTestId("repo-manager-row-p1")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-manager-row-p2")).not.toBeInTheDocument();
  });

  it("reports when a search matches nothing", () => {
    render(<RepoManagerModal {...baseProps} />);
    fireEvent.change(screen.getByTestId("repo-manager-search"), { target: { value: "zzz" } });

    expect(screen.getByTestId("repo-manager-empty")).toBeInTheDocument();
  });

  it("hides archived repos by default and shows them in All", () => {
    render(
      <RepoManagerModal
        {...baseProps}
        projects={[
          project("p1", "WB"),
          project("p2", "workstreams", { archived: true }),
        ]}
      />,
    );

    expect(screen.getByTestId("repo-manager-row-p1")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-manager-row-p2")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("repo-manager-filter"), {
      target: { value: "all" },
    });
    expect(screen.getByTestId("repo-manager-row-p2")).toHaveAttribute(
      "data-archived",
      "true",
    );
  });

  it("can show only non-dormant repos", () => {
    render(<RepoManagerModal {...baseProps} workstreams={[ws("w1", "p1")]} />);

    fireEvent.change(screen.getByTestId("repo-manager-filter"), {
      target: { value: "non_dormant" },
    });

    expect(screen.getByTestId("repo-manager-row-p1")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-manager-row-p2")).not.toBeInTheDocument();
  });

  it("selecting a repo loads it into the edit form", () => {
    render(<RepoManagerModal {...baseProps} />);

    fireEvent.click(screen.getByTestId("repo-manager-row-p2"));

    expect(screen.getByTestId("repo-manager-name")).toHaveValue("workstreams");
  });

  it("saves edits through onUpdateProject", () => {
    const onUpdateProject = vi.fn();
    render(<RepoManagerModal {...baseProps} onUpdateProject={onUpdateProject} />);

    fireEvent.click(screen.getByTestId("repo-manager-row-p1"));
    fireEvent.change(screen.getByTestId("repo-manager-name"), { target: { value: "WB renamed" } });
    fireEvent.change(screen.getByTestId("repo-manager-command"), { target: { value: "copilot --yolo" } });
    fireEvent.click(screen.getByTestId("repo-manager-save"));

    expect(onUpdateProject).toHaveBeenCalledWith("p1", {
      name: "WB renamed",
      color: "#89b4fa",
      copilot_command: "copilot --yolo",
    });
  });

  it("stores an empty copilot command as null so it inherits the global one", () => {
    const onUpdateProject = vi.fn();
    render(
      <RepoManagerModal
        {...baseProps}
        projects={[project("p1", "WB", { copilot_command: "old" })]}
        onUpdateProject={onUpdateProject}
      />,
    );

    fireEvent.click(screen.getByTestId("repo-manager-row-p1"));
    fireEvent.change(screen.getByTestId("repo-manager-command"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("repo-manager-save"));

    expect(onUpdateProject).toHaveBeenCalledWith("p1", expect.objectContaining({ copilot_command: null }));
  });

  it("archives and restores a repo without deleting it", () => {
    const onUpdateProject = vi.fn();
    const { rerender } = render(
      <RepoManagerModal {...baseProps} onUpdateProject={onUpdateProject} />,
    );

    fireEvent.click(screen.getByTestId("repo-manager-row-p1"));
    fireEvent.click(screen.getByTestId("repo-manager-archive"));
    expect(onUpdateProject).toHaveBeenCalledWith("p1", { archived: true });

    rerender(
      <RepoManagerModal
        {...baseProps}
        projects={[
          project("p1", "WB", { archived: true }),
          project("p2", "workstreams"),
        ]}
        onUpdateProject={onUpdateProject}
      />,
    );
    fireEvent.change(screen.getByTestId("repo-manager-filter"), {
      target: { value: "all" },
    });
    fireEvent.click(screen.getByTestId("repo-manager-row-p1"));
    expect(screen.getByTestId("repo-manager-archive")).toHaveTextContent("Restore repo");
    fireEvent.click(screen.getByTestId("repo-manager-archive"));
    expect(onUpdateProject).toHaveBeenCalledWith("p1", { archived: false });
  });

  it("refuses to save a blank repo name", () => {
    const onUpdateProject = vi.fn();
    render(<RepoManagerModal {...baseProps} onUpdateProject={onUpdateProject} />);

    fireEvent.click(screen.getByTestId("repo-manager-row-p1"));
    fireEvent.change(screen.getByTestId("repo-manager-name"), { target: { value: "  " } });
    fireEvent.click(screen.getByTestId("repo-manager-save"));

    expect(onUpdateProject).not.toHaveBeenCalled();
  });

  it("exposes import and create actions", () => {
    const onImportProject = vi.fn();
    const onCreateProject = vi.fn();
    render(
      <RepoManagerModal {...baseProps} onImportProject={onImportProject} onCreateProject={onCreateProject} />,
    );

    fireEvent.click(screen.getByTestId("repo-manager-import"));
    fireEvent.click(screen.getByTestId("repo-manager-create"));

    expect(onImportProject).toHaveBeenCalled();
    expect(onCreateProject).toHaveBeenCalled();
  });

  it("guides a first-run user when there are no repos yet", () => {
    // The whole option rests on repo setup being rare — true on day 100, false
    // on day 1. With zero repos the manager must lead with Import/Create.
    render(<RepoManagerModal {...baseProps} projects={[]} workstreams={[]} />);

    expect(screen.getByTestId("repo-manager-first-run")).toBeInTheDocument();
    expect(screen.getByTestId("repo-manager-import")).toBeInTheDocument();
  });

  it("closes on Escape and on backdrop click, but not on a click inside", () => {
    const onClose = vi.fn();
    render(<RepoManagerModal {...baseProps} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("repo-manager-panel"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("repo-manager-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
