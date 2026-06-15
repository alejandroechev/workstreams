import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ChangeWorktreeForm } from "../ChangeWorktreeForm";
import type { ChangeWorktreeFormProps } from "../ChangeWorktreeForm";
import type { Tile, Workstream } from "../../domain/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

const mockedOpen = vi.mocked(open);
const mockedInvoke = vi.mocked(invoke);

describe("ChangeWorktreeForm", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mockedOpen.mockResolvedValue(null);
    mockedInvoke.mockResolvedValue({
      is_worktree: true,
      parent_repo_name: "repo",
      parent_repo_path: "C:\\repo",
      branch: "main",
      git_remote: null,
    });
  });

  const workstream: Workstream = {
    id: "ws1",
    name: "Feature X",
    description: null,
    directory: "C:\\repo-a",
    git_repo: null,
    git_branch: "main",
    status: "active",
    project_id: null,
    workstream_type: "worktree",
    worktree_branch: "main",
    created_at: "",
    updated_at: "",
  };

  const tile = (id: string, tile_type: Tile["tile_type"], title: string | null = null): Tile => ({
    id,
    workstream_id: "ws1",
    tile_type,
    title,
    config_json: "{}",
    created_at: "",
    updated_at: "",
  });

  const renderForm = (opts?: { tiles?: Tile[]; onSubmit?: ChangeWorktreeFormProps["onSubmit"] }) => {
    const onCancel = vi.fn();
    const onSubmit: ChangeWorktreeFormProps["onSubmit"] =
      opts?.onSubmit ?? (vi.fn().mockResolvedValue(undefined) as unknown as ChangeWorktreeFormProps["onSubmit"]);
    render(
      <ChangeWorktreeForm
        workstream={workstream}
        tiles={opts?.tiles ?? []}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    return { onCancel, onSubmit };
  };

  const getRadio = (testId: string) => screen.getByTestId(testId).querySelector("input") as HTMLInputElement;

  it("defaults to switch_existing mode and shows current workstream directory", () => {
    renderForm();
    expect(getRadio("cwt-mode-switch_existing").checked).toBe(true);
    expect(screen.getByText(/current:/i).textContent).toContain("C:\\repo-a");
  });

  it("switching to create_new shows branch name input and hides directory picker", () => {
    renderForm();
    fireEvent.click(getRadio("cwt-mode-create_new"));
    expect(screen.getByTestId("cwt-branch-name")).toBeTruthy();
    expect(screen.queryByText(/pick directory/i)).toBeNull();
  });

  it("disables submit when switch_existing has no directory", () => {
    renderForm();
    expect((screen.getByTestId("cwt-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables submit when create_new has no branch name", () => {
    renderForm();
    fireEvent.click(getRadio("cwt-mode-create_new"));
    expect((screen.getByTestId("cwt-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("submits switch_existing with a picked directory", async () => {
    mockedOpen.mockResolvedValue("C:\\repo-b");
    const { onCancel, onSubmit } = renderForm();
    fireEvent.click(screen.getByText(/pick directory/i));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("detect_worktree_info", { directory: "C:\\repo-b" }));
    fireEvent.click(screen.getByTestId("cwt-submit"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("switch_existing", { directory: "C:\\repo-b" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("submits create_new with a branch name and derived folder name", async () => {
    const { onSubmit } = renderForm();
    fireEvent.click(getRadio("cwt-mode-create_new"));
    fireEvent.change(screen.getByTestId("cwt-branch-name"), { target: { value: "alejandroe/feat-x" } });
    fireEvent.click(screen.getByTestId("cwt-submit"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("create_new", { branchName: "alejandroe/feat-x", folderName: "feat-x", pullBaseFirst: true }));
  });

  it("submits create_new with pullBaseFirst=false when the user unticks the box", async () => {
    const { onSubmit } = renderForm();
    fireEvent.click(getRadio("cwt-mode-create_new"));
    fireEvent.change(screen.getByTestId("cwt-branch-name"), { target: { value: "alejandroe/feat-y" } });
    fireEvent.click(screen.getByTestId("cwt-pull-base"));
    fireEvent.click(screen.getByTestId("cwt-submit"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("create_new", { branchName: "alejandroe/feat-y", folderName: "feat-y", pullBaseFirst: false }));
  });

  it("never shows restart warning (restarts removed per UX decision)", () => {
    const { rerender } = render(
      <ChangeWorktreeForm workstream={workstream} tiles={[tile("t1", "terminal"), tile("t2", "copilot_session")]} onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.queryByText(/will be restarted/i)).toBeNull();

    rerender(<ChangeWorktreeForm workstream={workstream} tiles={[tile("t3", "code_viewer")]} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByText(/will be restarted/i)).toBeNull();
  });

  it("surfaces onSubmit rejection as an alert and keeps the modal open", async () => {
    mockedOpen.mockResolvedValue("C:\\repo-b");
    const onSubmit = vi.fn().mockRejectedValue(new Error("Change failed"));
    const { onCancel } = renderForm({ onSubmit });
    fireEvent.click(screen.getByText(/pick directory/i));
    await waitFor(() => expect((screen.getByTestId("cwt-submit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cwt-submit"));
    expect((await screen.findByRole("alert")).textContent).toContain("Change failed");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
