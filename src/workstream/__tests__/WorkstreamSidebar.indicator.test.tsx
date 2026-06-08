import { describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
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

function renderWith(loadedWsIds?: Set<string>) {
  return render(
    <WorkstreamSidebar
      projects={[]}
      workstreams={[mk("a", "Alpha"), mk("b", "Beta")]}
      activeWsId="a"
      loadedWsIds={loadedWsIds}
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      onReorderWorkstreams={vi.fn()}
      onChangeStatus={vi.fn()}
    />,
  );
}

describe("WorkstreamSidebar activity indicator", () => {
  it("renders idle indicators when loadedWsIds is omitted (back-compat)", () => {
    const { getAllByTestId, queryAllByTestId } = renderWith(undefined);
    expect(getAllByTestId("ws-indicator-idle").length).toBeGreaterThanOrEqual(2);
    expect(queryAllByTestId("ws-indicator-stopped")).toHaveLength(0);
    cleanup();
  });

  it("renders stopped indicator for workstreams not in loadedWsIds", () => {
    const { getAllByTestId, queryAllByTestId } = renderWith(new Set(["a"]));
    // 'a' is loaded → idle, 'b' is stopped.
    expect(getAllByTestId("ws-indicator-stopped")).toHaveLength(1);
    expect(queryAllByTestId("ws-indicator-idle").length).toBeGreaterThanOrEqual(1);
    cleanup();
  });
});
