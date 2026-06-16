import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ArchiveWorkstreamDialog } from "../ArchiveWorkstreamDialog";

afterEach(() => cleanup());

describe("ArchiveWorkstreamDialog", () => {
  it("renders the workstream name and Archive/Cancel buttons", () => {
    render(<ArchiveWorkstreamDialog workstreamName="My WS" isWorktree onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("My WS")).toBeTruthy();
    expect(screen.getByTestId("archive-confirm")).toBeTruthy();
    expect(screen.getByTestId("archive-cancel")).toBeTruthy();
  });

  it("shows the delete-worktree checkbox (checked by default) for worktree workstreams", () => {
    render(<ArchiveWorkstreamDialog workstreamName="WS" isWorktree onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const cb = screen.getByTestId("archive-delete-worktree") as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it("hides the checkbox for non-worktree workstreams", () => {
    render(<ArchiveWorkstreamDialog workstreamName="WS" isWorktree={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("archive-delete-worktree")).toBeNull();
  });

  it("confirms with deleteWorktree=true by default", () => {
    const onConfirm = vi.fn();
    render(<ArchiveWorkstreamDialog workstreamName="WS" isWorktree onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId("archive-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("confirms with deleteWorktree=false when unchecked", () => {
    const onConfirm = vi.fn();
    render(<ArchiveWorkstreamDialog workstreamName="WS" isWorktree onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId("archive-delete-worktree"));
    fireEvent.click(screen.getByTestId("archive-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("always confirms false for non-worktree workstreams (no checkbox)", () => {
    const onConfirm = vi.fn();
    render(<ArchiveWorkstreamDialog workstreamName="WS" isWorktree={false} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId("archive-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("calls onCancel on Cancel + backdrop click", () => {
    const onCancel = vi.fn();
    render(<ArchiveWorkstreamDialog workstreamName="WS" isWorktree onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("archive-cancel"));
    fireEvent.click(screen.getByTestId("archive-workstream-dialog"));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
