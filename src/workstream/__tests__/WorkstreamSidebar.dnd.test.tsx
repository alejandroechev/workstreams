import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import WorkstreamSidebar from "../WorkstreamSidebar";
import type { Workstream, Project } from "../../domain/types";

// Tauri event listener stub — sidebar listens for ws-bell + ws-activity events.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const now = new Date().toISOString();
const mk = (id: string, name: string, project_id: string | null = null): Workstream => ({
  id,
  name,
  description: null,
  directory: `C:\\repos\\${id}`,
  git_repo: null,
  git_branch: null,
  status: "active",
  project_id,
  workstream_type: "base_repo",
  worktree_branch: null,
  created_at: now,
  updated_at: now,
});

function renderSidebar(extra: { workstreams?: Workstream[]; projects?: Project[] } = {}) {
  const onReorderWorkstreams = vi.fn();
  const workstreams = extra.workstreams ?? [mk("a", "Alpha"), mk("b", "Beta"), mk("c", "Gamma")];
  const projects = extra.projects ?? [];
  const utils = render(
    <WorkstreamSidebar
      projects={projects}
      workstreams={workstreams}
      activeWsId="a"
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      onReorderWorkstreams={onReorderWorkstreams}
      onChangeStatus={vi.fn()}
    />,
  );
  return { ...utils, onReorderWorkstreams };
}

describe("WorkstreamSidebar drag-and-drop reorder", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // jsdom's DragEvent doesn't carry a DataTransfer by default; we have to
  // provide a stub for handleDragStart's effectAllowed/setData calls.
  const makeDataTransfer = () => ({
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn(),
    getData: vi.fn(() => ""),
    types: [] as string[],
  });

  function fireDragStart(el: HTMLElement) {
    fireEvent.dragStart(el, { dataTransfer: makeDataTransfer() });
  }

  function fireDragOver(el: HTMLElement) {
    const ev = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: makeDataTransfer(), writable: false });
    el.dispatchEvent(ev);
    return ev;
  }

  function fireDrop(el: HTMLElement) {
    fireEvent.drop(el, { dataTransfer: makeDataTransfer() });
  }

  it("dragging Alpha onto Gamma reorders to [Beta, Gamma, Alpha] (forward move)", () => {
    const { container, onReorderWorkstreams } = renderSidebar();
    const alpha = container.querySelector('[data-workstream-id="a"]') as HTMLElement;
    const gamma = container.querySelector('[data-workstream-id="c"]') as HTMLElement;

    fireDragStart(alpha);
    const dragOverEvent = fireDragOver(gamma);
    expect(dragOverEvent.defaultPrevented).toBe(true);

    fireDrop(gamma);
    expect(onReorderWorkstreams).toHaveBeenCalledWith(["b", "c", "a"]);
  });

  it("dragging Gamma onto Alpha reorders to [Gamma, Alpha, Beta] (backward move)", () => {
    const { container, onReorderWorkstreams } = renderSidebar();
    const alpha = container.querySelector('[data-workstream-id="a"]') as HTMLElement;
    const gamma = container.querySelector('[data-workstream-id="c"]') as HTMLElement;

    fireDragStart(gamma);
    const dragOverEvent = fireDragOver(alpha);
    expect(dragOverEvent.defaultPrevented).toBe(true);

    fireDrop(alpha);
    expect(onReorderWorkstreams).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("dragging a row onto itself is a no-op (no reorder call, dragover NOT prevented)", () => {
    const { container, onReorderWorkstreams } = renderSidebar();
    const alpha = container.querySelector('[data-workstream-id="a"]') as HTMLElement;

    fireDragStart(alpha);
    const dragOverEvent = fireDragOver(alpha);
    expect(dragOverEvent.defaultPrevented).toBe(false);

    fireDrop(alpha);
    expect(onReorderWorkstreams).not.toHaveBeenCalled();
  });

  it("regression: dragover preventDefault on a different target after dragStart", () => {
    // This guards the handler logic itself — that handleDragOver correctly
    // calls preventDefault() when given a valid drop target. Note: this
    // does NOT catch the real-world Tauri bug where the OS-level
    // dragDropEnabled=true setting intercepted HTML5 drag events before
    // they reached our handlers at all. That cause is config-level and
    // is fixed in src-tauri/tauri.conf.json by setting dragDropEnabled
    // on the window to false (we don't use OS-to-app file drops).
    const { container, onReorderWorkstreams } = renderSidebar();
    const alpha = container.querySelector('[data-workstream-id="a"]') as HTMLElement;
    const beta = container.querySelector('[data-workstream-id="b"]') as HTMLElement;

    fireDragStart(alpha);
    const dragOverEvent = fireDragOver(beta);
    expect(dragOverEvent.defaultPrevented).toBe(true);

    fireDrop(beta);
    expect(onReorderWorkstreams).toHaveBeenCalledWith(["b", "a", "c"]);
  });
});
