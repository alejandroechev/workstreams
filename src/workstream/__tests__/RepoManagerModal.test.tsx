import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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
