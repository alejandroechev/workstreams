import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkstreamCreateForm from "../WorkstreamCreateForm";
import type { Project } from "../../domain/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

describe("WorkstreamCreateForm", () => {
  afterEach(() => cleanup());

  const projects: Project[] = [
    { id: "p1", name: "App", directory: "C:\\repo", git_remote: null, color: "#89b4fa", created_at: "", updated_at: "" },
  ];

  const getRadio = (testId: string) =>
    screen.getByTestId(testId).querySelector("input") as HTMLInputElement;

  it("defaults to base_repo + new session when no project preselected", () => {
    render(<WorkstreamCreateForm projects={projects} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(getRadio("ws-create-repo-base_repo").checked).toBe(true);
    expect(getRadio("ws-create-session-new").checked).toBe(true);
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
});
