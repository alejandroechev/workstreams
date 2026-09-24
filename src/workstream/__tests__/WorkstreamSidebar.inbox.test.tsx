import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import WorkstreamSidebar from "../WorkstreamSidebar";
import type { Project, Workstream } from "../../domain/types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

function project(id: string, name: string): Project {
  return {
    id,
    name,
    directory: `/Code/${name}`,
    git_remote: null,
    color: "#89b4fa",
    copilot_command: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function ws(id: string): Workstream {
  return {
    id,
    name: id,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: "p1",
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function renderSidebar(over: Record<string, unknown> = {}) {
  return render(
    <WorkstreamSidebar
      projects={[project("p1", "waimea")]}
      workstreams={[ws("w1")]}
      activeWsId={null}
      onChangeStatus={vi.fn()}
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      onOpenInbox={vi.fn()}
      {...over}
    />,
  );
}

/**
 * The badge is the only passive signal that a review landed -- the poller runs
 * whether or not the inbox is open, so if the count does not catch the eye the
 * feature is reduced to something you have to remember to click.
 */
describe("WorkstreamSidebar PR inbox badge", () => {
  it("renders the unread count as a filled pill, not plain footer text", () => {
    renderSidebar({ inboxUnread: 3 });
    const badge = screen.getByTestId("pr-inbox-unread");
    expect(badge).toHaveTextContent("3");
    // A pill: accent fill with dark text, so it reads as a count and not as
    // another dim footer label.
    expect(badge).toHaveStyle({ background: "#f38ba8", color: "#11111b" });
    expect(badge).toHaveAttribute("aria-label", "3 unread review assignments");
  });

  it("uses the singular form for one assignment", () => {
    renderSidebar({ inboxUnread: 1 });
    expect(screen.getByTestId("pr-inbox-unread")).toHaveAttribute(
      "aria-label",
      "1 unread review assignment",
    );
  });

  it("caps the badge at 99+ so a backlog cannot stretch the sidebar", () => {
    renderSidebar({ inboxUnread: 250 });
    expect(screen.getByTestId("pr-inbox-unread")).toHaveTextContent("99+");
  });

  it("brightens the whole row while anything is unread", () => {
    const { rerender } = renderSidebar({ inboxUnread: 0 });
    expect(screen.getByTestId("pr-inbox-button")).toHaveStyle({ color: "#6c7086" });
    rerender(
      <WorkstreamSidebar
        projects={[project("p1", "waimea")]}
        workstreams={[ws("w1")]}
        activeWsId={null}
        onChangeStatus={vi.fn()}
        onSelectWorkstream={vi.fn()}
        onCreateProject={vi.fn()}
        onImportProject={vi.fn()}
        onCreateWorkstream={vi.fn()}
        onArchiveWorkstream={vi.fn()}
        onRenameWorkstream={vi.fn()}
        onUpdateProject={vi.fn()}
        onOpenInbox={vi.fn()}
        inboxUnread={2}
      />,
    );
    expect(screen.getByTestId("pr-inbox-button")).toHaveStyle({ color: "#cdd6f4" });
  });

  it("omits the badge when nothing is unread", () => {
    renderSidebar({ inboxUnread: 0 });
    expect(screen.queryByTestId("pr-inbox-unread")).not.toBeInTheDocument();
  });
});
