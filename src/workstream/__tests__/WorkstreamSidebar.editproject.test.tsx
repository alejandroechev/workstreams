import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import WorkstreamSidebar from "../WorkstreamSidebar";
import type { Project } from "../../domain/types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const now = new Date().toISOString();
const mkProject = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "App",
  directory: "C:\\repos\\app",
  git_remote: null,
  color: "#89b4fa",
  copilot_command: null,
  created_at: now,
  updated_at: now,
  ...over,
});

function renderWith(
  project: Project,
  handlers: Partial<React.ComponentProps<typeof WorkstreamSidebar>> = {},
) {
  return render(
    <WorkstreamSidebar
      projects={[project]}
      workstreams={[]}
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
      {...handlers}
    />,
  );
}

function openEditModal(projectName: string) {
  fireEvent.click(screen.getByText(projectName));
}

describe("WorkstreamSidebar project edit — Copilot command override", () => {
  afterEach(() => cleanup());

  it("prefills the command field empty (inherit) and shows the global as placeholder", () => {
    renderWith(mkProject({ copilot_command: null }));
    openEditModal("App");
    const input = screen.getByTestId("edit-project-command") as HTMLInputElement;
    expect(input.value).toBe("");
    // Placeholder is the global command (default agency copilot --yolo).
    expect(input.placeholder).toContain("copilot");
  });

  it("prefills the existing override when the project has one", () => {
    renderWith(mkProject({ copilot_command: "copilot --yolo" }));
    openEditModal("App");
    const input = screen.getByTestId("edit-project-command") as HTMLInputElement;
    expect(input.value).toBe("copilot --yolo");
  });

  it("saves a trimmed override via onUpdateProject", () => {
    const onUpdateProject = vi.fn();
    renderWith(mkProject(), { onUpdateProject });
    openEditModal("App");
    fireEvent.change(screen.getByTestId("edit-project-command"), {
      target: { value: "  my-copilot --flag  " },
    });
    fireEvent.click(screen.getByText("Save"));
    expect(onUpdateProject).toHaveBeenCalledWith("p1", {
      name: "App",
      color: "#89b4fa",
      copilot_command: "my-copilot --flag",
    });
  });

  it("clears the override to null when the field is emptied", () => {
    const onUpdateProject = vi.fn();
    renderWith(mkProject({ copilot_command: "copilot --yolo" }), { onUpdateProject });
    openEditModal("App");
    fireEvent.change(screen.getByTestId("edit-project-command"), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save"));
    expect(onUpdateProject).toHaveBeenCalledWith("p1", {
      name: "App",
      color: "#89b4fa",
      copilot_command: null,
    });
  });
});
