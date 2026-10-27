import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkstreamCreateForm from "../WorkstreamCreateForm";
import type { Project } from "../../domain/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

describe("WorkstreamCreateForm", () => {
  afterEach(() => cleanup());

  const projects: Project[] = [
    { id: "p1", name: "App", directory: "C:\\repo", git_remote: null, color: "#89b4fa", copilot_command: null, archived: false, created_at: "", updated_at: "" },
  ];

  const getRadio = (testId: string) =>
    screen.getByTestId(testId).querySelector("input") as HTMLInputElement;

  it("defaults to a new folder + new session when no repo is selected", () => {
    render(<WorkstreamCreateForm projects={projects} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(getRadio("ws-create-repo-standalone").checked).toBe(true);
    expect(screen.queryByTestId("ws-create-repo-base_repo")).toBeNull();
    expect(screen.queryByTestId("ws-create-repo-worktree")).toBeNull();
    expect(getRadio("ws-create-session-new").checked).toBe(true);
  });

  it("creates a workstream without a repo in a new folder under the chosen parent folder", () => {
    const onSubmit = vi.fn();
    render(<WorkstreamCreateForm projects={projects} standaloneRoot="~/Workstreams" onSubmit={onSubmit} onCancel={vi.fn()} />);
    const parent = screen.getByTestId("ws-create-parent-folder") as HTMLInputElement;
    expect(parent.value).toBe("~/Workstreams");
    fireEvent.change(screen.getByTestId("ws-create-name"), { target: { value: "Café ideas" } });
    expect(screen.getByTestId("ws-create-folder-preview")).toHaveTextContent("~/Workstreams/cafe-ideas");
    fireEvent.change(parent, { target: { value: "/data/scratch" } });
    fireEvent.click(screen.getByTestId("ws-create-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [name, dir, opts] = onSubmit.mock.calls[0];
    expect([name, dir]).toEqual(["Café ideas", ""]);
    expect(opts).toMatchObject({ workstreamType: "standalone", parentFolder: "/data/scratch", sessionChoice: "new", projectId: undefined });
  });

  it("needs a parent folder for a workstream without a repo", () => {
    render(<WorkstreamCreateForm projects={projects} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId("ws-create-name"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("ws-create-parent-folder"), { target: { value: "  " } });
    expect((screen.getByTestId("ws-create-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("allows choosing either session type when import_worktree is selected", () => {
    render(<WorkstreamCreateForm projects={projects} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(getRadio("ws-create-repo-import_worktree"));
    // Default still falls through to "new"; both radios remain enabled.
    expect(getRadio("ws-create-session-new").checked).toBe(true);
    expect(getRadio("ws-create-session-existing").disabled).toBe(false);
    expect(getRadio("ws-create-session-new").disabled).toBe(false);
    // User can switch to existing if they want.
    fireEvent.click(getRadio("ws-create-session-existing"));
    expect(getRadio("ws-create-session-existing").checked).toBe(true);
  });

  it("submits the correct payload for new worktree + new session", () => {
    const onSubmit = vi.fn();
    render(<WorkstreamCreateForm project={projects[0]} projects={projects} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId("ws-create-name"), { target: { value: "Feature X" } });
    fireEvent.click(screen.getByTestId("ws-create-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [name, dir, opts] = onSubmit.mock.calls[0];
    expect(name).toBe("Feature X");
    expect(dir).toBe("C:\\repo");
    expect(opts.workstreamType).toBe("worktree");
    expect(opts.worktreeBranch).toBe("alejandroe/feature-x");
    expect(opts.sessionChoice).toBe("new");
    expect(opts.projectId).toBe("p1");
  });

  it("submits sessionChoice=existing when user picks existing session", () => {
    const onSubmit = vi.fn();
    render(<WorkstreamCreateForm project={projects[0]} projects={projects} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId("ws-create-name"), { target: { value: "Feature Y" } });
    fireEvent.click(getRadio("ws-create-repo-base_repo"));
    fireEvent.click(getRadio("ws-create-session-existing"));
    fireEvent.click(screen.getByTestId("ws-create-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][2].sessionChoice).toBe("existing");
    expect(onSubmit.mock.calls[0][2].workstreamType).toBe("base_repo");
  });

  it("disables submit while name or directory is empty", () => {
    render(<WorkstreamCreateForm projects={projects} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const btn = screen.getByTestId("ws-create-submit") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("does not offer archived repos for a new workstream", () => {
    render(
      <WorkstreamCreateForm
        projects={[
          ...projects,
          { ...projects[0], id: "p2", name: "Archived", archived: true },
        ]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "App" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Archived" })).toBeNull();
  });
});
