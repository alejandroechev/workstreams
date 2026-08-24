import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { CommentsPanel } from "../CommentsPanel";
import type { SessionFileComment } from "../../domain/file-comments";

function c(over: Partial<SessionFileComment> & { id: string }): SessionFileComment {
  return {
    workstream_id: "ws-1",
    file: "src/a.ts",
    anchor_line_start: 4,
    anchor_line_end: 4,
    anchor_text: null,
    body: "please rename this",
    author: "reviewer",
    parent_id: null,
    status: "open",
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:00:00Z",
    ...over,
  };
}

const noop = () => {};

describe("CommentsPanel", () => {
  it("groups threads under their file with a count", () => {
    render(
      <CommentsPanel
        comments={[c({ id: "a1" }), c({ id: "b1", file: "src/b.ts" })]}
        selectedId={null}
        onSelect={noop}
      />,
    );

    expect(screen.getByTestId("comments-file-src/a.ts")).toBeInTheDocument();
    expect(screen.getByTestId("comments-file-src/b.ts")).toBeInTheDocument();
    expect(screen.getByTestId("comments-thread-a1")).toHaveTextContent("please rename this");
  });

  it("shows the real author name for an imported comment", () => {
    render(
      <CommentsPanel
        comments={[c({ id: "ado-1", author: "Eduardo Fernandez" })]}
        selectedId={null}
        onSelect={noop}
      />,
    );

    expect(screen.getByTestId("comments-thread-ado-1")).toHaveTextContent("Eduardo Fernandez");
  });

  it("renders the reply count and hides replies as top-level rows", () => {
    render(
      <CommentsPanel
        comments={[
          c({ id: "root" }),
          c({ id: "r1", parent_id: "root" }),
          c({ id: "r2", parent_id: "root" }),
        ]}
        selectedId={null}
        onSelect={noop}
      />,
    );

    expect(screen.queryByTestId("comments-thread-r1")).not.toBeInTheDocument();
    expect(screen.getByTestId("comments-thread-root")).toHaveTextContent("2");
  });

  it("calls onSelect with the thread root when a row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <CommentsPanel comments={[c({ id: "a1" })]} selectedId={null} onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByTestId("comments-thread-a1"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("marks the selected row", () => {
    render(
      <CommentsPanel
        comments={[c({ id: "a1" }), c({ id: "a2", anchor_line_start: 9 })]}
        selectedId="a2"
        onSelect={noop}
      />,
    );

    expect(screen.getByTestId("comments-thread-a2")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("comments-thread-a1")).toHaveAttribute("data-selected", "false");
  });

  it("keeps resolved threads visible but visually closed", () => {
    render(
      <CommentsPanel
        comments={[c({ id: "done", status: "resolved" })]}
        selectedId={null}
        onSelect={noop}
      />,
    );

    expect(screen.getByTestId("comments-thread-done")).toHaveAttribute("data-closed", "true");
  });

  it("offers no per-row resolve or reply actions (navigation only)", () => {
    render(<CommentsPanel comments={[c({ id: "a1" })]} selectedId={null} onSelect={noop} />);

    const row = screen.getByTestId("comments-thread-a1");
    expect(within(row).queryByRole("button", { name: /resolve|reply/i })).not.toBeInTheDocument();
  });

  it("filters by status through the toolbar", () => {
    render(
      <CommentsPanel
        comments={[c({ id: "open-1" }), c({ id: "res-1", status: "resolved" })]}
        selectedId={null}
        onSelect={noop}
      />,
    );

    fireEvent.change(screen.getByTestId("comments-filter-status"), { target: { value: "open" } });

    expect(screen.getByTestId("comments-thread-open-1")).toBeInTheDocument();
    expect(screen.queryByTestId("comments-thread-res-1")).not.toBeInTheDocument();
  });

  it("filters by author and by free text", () => {
    render(
      <CommentsPanel
        comments={[
          c({ id: "mine", body: "rename this" }),
          c({ id: "theirs", author: "Eduardo Fernandez", body: "use Duration" }),
        ]}
        selectedId={null}
        onSelect={noop}
      />,
    );

    fireEvent.change(screen.getByTestId("comments-filter-author"), {
      target: { value: "Eduardo Fernandez" },
    });
    expect(screen.queryByTestId("comments-thread-mine")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("comments-filter-author"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("comments-filter-text"), { target: { value: "duration" } });
    expect(screen.getByTestId("comments-thread-theirs")).toBeInTheDocument();
    expect(screen.queryByTestId("comments-thread-mine")).not.toBeInTheDocument();
  });

  it("reports an empty state when filters exclude everything", () => {
    render(<CommentsPanel comments={[c({ id: "a1" })]} selectedId={null} onSelect={noop} />);

    fireEvent.change(screen.getByTestId("comments-filter-text"), { target: { value: "zzz" } });
    expect(screen.getByTestId("comments-empty")).toBeInTheDocument();
  });

  it("shows the session prompt instead of an empty list when unbound", () => {
    render(
      <CommentsPanel comments={[]} selectedId={null} onSelect={noop} unbound />,
    );

    expect(screen.getByTestId("comments-unbound")).toHaveTextContent(/Copilot session/i);
    expect(screen.queryByTestId("comments-empty")).not.toBeInTheDocument();
  });

  it("badges a drifted anchor using the supplied file lines", () => {
    render(
      <CommentsPanel
        comments={[
          c({ id: "fresh-1", anchor_text: "const b = 2;", anchor_line_start: 2, anchor_line_end: 2 }),
          c({ id: "drift-1", anchor_text: "gone();", anchor_line_start: 3, anchor_line_end: 3 }),
        ]}
        selectedId={null}
        onSelect={noop}
        fileLines={{ "src/a.ts": ["const a = 1;", "const b = 2;", "const c = 3;"] }}
      />,
    );

    expect(screen.getByTestId("comments-drift-drift-1")).toBeInTheDocument();
    expect(screen.queryByTestId("comments-drift-fresh-1")).not.toBeInTheDocument();
  });
});

describe("deleting from the list", () => {
  it("offers no delete control when no handler is supplied", () => {
    render(<CommentsPanel comments={[c({ id: "a1" })]} selectedId={null} onSelect={noop} />);
    expect(screen.queryByTestId("comments-delete-a1")).not.toBeInTheDocument();
  });

  it("deletes the thread root it belongs to", () => {
    const onDelete = vi.fn();
    render(
      <CommentsPanel
        comments={[c({ id: "a1" })]}
        selectedId={null}
        onSelect={noop}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByTestId("comments-delete-a1"));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("does not select the row when its delete button is clicked", () => {
    // The button sits inside a clickable row; without stopPropagation the
    // click would also navigate to the file being deleted from.
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <CommentsPanel
        comments={[c({ id: "a1" })]}
        selectedId={null}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByTestId("comments-delete-a1"));
    expect(onDelete).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("offers delete on an imported thread too", () => {
    // Imported rows are a local copy of somebody else's words -- deleting one
    // here does not touch the source review, and these are exactly the
    // comments that most need clearing out.
    const onDelete = vi.fn();
    render(
      <CommentsPanel
        comments={[c({ id: "ado-1", author: "Eduardo Fernandez" })]}
        selectedId={null}
        onSelect={noop}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByTestId("comments-delete-ado-1"));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "ado-1" }));
  });

  it("offers delete on a resolved thread", () => {
    const onDelete = vi.fn();
    render(
      <CommentsPanel
        comments={[c({ id: "a1", status: "resolved" })]}
        selectedId={null}
        onSelect={noop}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByTestId("comments-delete-a1")).toBeInTheDocument();
  });

  it("puts the control on roots only, never on replies", () => {
    // Replies have no row of their own; deleting a root already cascades, so a
    // per-reply control would be both unreachable and misleading.
    const onDelete = vi.fn();
    render(
      <CommentsPanel
        comments={[c({ id: "a1" }), c({ id: "r1", parent_id: "a1", author: "agent" })]}
        selectedId={null}
        onSelect={noop}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByTestId("comments-delete-a1")).toBeInTheDocument();
    expect(screen.queryByTestId("comments-delete-r1")).not.toBeInTheDocument();
  });

  it("names the reply count so a cascade is never a surprise", () => {
    const onDelete = vi.fn();
    render(
      <CommentsPanel
        comments={[
          c({ id: "a1" }),
          c({ id: "r1", parent_id: "a1", author: "agent" }),
          c({ id: "r2", parent_id: "a1", author: "agent" }),
        ]}
        selectedId={null}
        onSelect={noop}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByTestId("comments-delete-a1")).toHaveAttribute(
      "title",
      expect.stringContaining("2 replies"),
    );
  });
});
