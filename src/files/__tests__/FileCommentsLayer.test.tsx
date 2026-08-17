import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as MonacoNs from "monaco-editor";

import { FileCommentsLayer } from "../FileCommentsLayer";
import type { SessionFileComment } from "../../domain/file-comments";

afterEach(() => {
  document.body.innerHTML = "";
});

function comment(): SessionFileComment {
  return {
    id: "c1",
    workstream_id: "ws-1",
    file: "src/a.ts",
    anchor_line_start: 2,
    anchor_line_end: 2,
    anchor_text: "second",
    body: "Please explain this.",
    author: "reviewer",
    parent_id: null,
    status: "open",
    created_at: "2026-08-12T00:00:00Z",
    updated_at: "2026-08-12T00:00:00Z",
  };
}

function editorHarness() {
  let selectionHandler:
    | ((event: MonacoNs.editor.ICursorSelectionChangedEvent) => void)
    | undefined;
  const zoneHost = document.createElement("div");
  document.body.appendChild(zoneHost);
  const editor = {
    getModel: () => ({ getValue: () => "first\nsecond\nthird\n" }),
    onDidChangeCursorSelection: (
      handler: (event: MonacoNs.editor.ICursorSelectionChangedEvent) => void,
    ) => {
      selectionHandler = handler;
      return { dispose: vi.fn() };
    },
    changeViewZones: (
      callback: (accessor: MonacoNs.editor.IViewZoneChangeAccessor) => void,
    ) => {
      callback({
        addZone: (zone: MonacoNs.editor.IViewZone) => {
          zoneHost.appendChild(zone.domNode);
          return "zone-1";
        },
        removeZone: vi.fn(),
        layoutZone: vi.fn(),
      } as unknown as MonacoNs.editor.IViewZoneChangeAccessor);
    },
  } as unknown as MonacoNs.editor.ICodeEditor;
  return {
    editor,
    selectLines(start: number, end: number) {
      selectionHandler?.({
        selection: {
          isEmpty: () => false,
          startLineNumber: start,
          endLineNumber: end,
        },
      } as MonacoNs.editor.ICursorSelectionChangedEvent);
    },
  };
}

describe("FileCommentsLayer", () => {
  it("renders existing threads as Monaco view zones", () => {
    const harness = editorHarness();
    render(
      <FileCommentsLayer
        editor={harness.editor}
        editorReadyToken={1}
        comments={[comment()]}
        enabled
      />,
    );

    expect(document.querySelector('[data-testid="comment-zone-c1"]')).toHaveTextContent(
      "Please explain this.",
    );
  });

  it("creates a comment from the selected modified-model lines", async () => {
    const harness = editorHarness();
    const onAddComment = vi.fn().mockResolvedValue(undefined);
    render(
      <FileCommentsLayer
        editor={harness.editor}
        editorReadyToken={1}
        comments={[]}
        enabled
        onAddComment={onAddComment}
      />,
    );

    act(() => harness.selectLines(2, 3));
    fireEvent.click(await screen.findByTestId("add-comment-floating"));
    fireEvent.change(screen.getByTestId("comment-composer-textarea"), {
      target: { value: "Check these lines." },
    });
    fireEvent.click(screen.getByTestId("comment-composer-save"));

    await waitFor(() =>
      expect(onAddComment).toHaveBeenCalledWith(
        2,
        3,
        "second\nthird",
        "Check these lines.",
      ),
    );
  });

  it("closes the composer and renders the created comment after save", async () => {
    const harness = editorHarness();
    let nextComments: SessionFileComment[] = [];
    const onAddComment = vi.fn(async (
      start: number,
      end: number,
      anchorText: string | null,
      body: string,
    ) => {
      nextComments = [{
        ...comment(),
        anchor_line_start: start,
        anchor_line_end: end,
        anchor_text: anchorText,
        body,
      }];
      return nextComments[0];
    });
    const { rerender } = render(
      <FileCommentsLayer
        editor={harness.editor}
        editorReadyToken={1}
        comments={[]}
        enabled
        onAddComment={onAddComment}
      />,
    );

    act(() => harness.selectLines(2, 2));
    fireEvent.click(await screen.findByTestId("add-comment-floating"));
    fireEvent.change(screen.getByTestId("comment-composer-textarea"), {
      target: { value: "Saved from the diff." },
    });
    fireEvent.click(screen.getByTestId("comment-composer-save"));
    await waitFor(() => expect(screen.queryByTestId("comment-composer")).toBeNull());

    rerender(
      <FileCommentsLayer
        editor={harness.editor}
        editorReadyToken={1}
        comments={nextComments}
        enabled
        onAddComment={onAddComment}
      />,
    );
    expect(document.querySelector('[data-testid="comment-zone-c1"]')).toHaveTextContent(
      "Saved from the diff.",
    );
  });

  it("shows a save error instead of leaving an inert composer", async () => {
    const harness = editorHarness();
    render(
      <FileCommentsLayer
        editor={harness.editor}
        editorReadyToken={1}
        comments={[]}
        enabled
        onAddComment={vi.fn().mockRejectedValue(new Error("database is locked"))}
      />,
    );

    act(() => harness.selectLines(2, 2));
    fireEvent.click(await screen.findByTestId("add-comment-floating"));
    fireEvent.change(screen.getByTestId("comment-composer-textarea"), {
      target: { value: "Will fail." },
    });
    fireEvent.click(screen.getByTestId("comment-composer-save"));

    expect(await screen.findByTestId("comment-composer-error")).toHaveTextContent(
      "database is locked",
    );
  });

  it("allows cancelling a pending save and ignores its late completion", async () => {
    const harness = editorHarness();
    let finish: (() => void) | null = null;
    render(
      <FileCommentsLayer
        editor={harness.editor}
        editorReadyToken={1}
        comments={[]}
        enabled
        onAddComment={() =>
          new Promise((resolve) => {
            finish = () => resolve(undefined);
          })
        }
      />,
    );

    act(() => harness.selectLines(2, 2));
    fireEvent.click(await screen.findByTestId("add-comment-floating"));
    fireEvent.change(screen.getByTestId("comment-composer-textarea"), {
      target: { value: "Slow save." },
    });
    fireEvent.click(screen.getByTestId("comment-composer-save"));
    await screen.findByText("Saving…");
    fireEvent.click(screen.getByTestId("comment-composer-cancel"));
    expect(screen.queryByTestId("comment-composer")).toBeNull();

    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("comment-composer")).toBeNull();
  });
});

describe("FileCommentsLayer imported authors and reply order", () => {
  it("attributes an imported ADO comment to its real author, not to 'you'", () => {
    const harness = editorHarness();
    const imported: SessionFileComment = {
      ...comment(),
      id: "ado-1513151-16261206-1",
      author: "Eduardo Fernandez",
      body: "you don't need to do this with the new FFI.",
    };

    render(
      <FileCommentsLayer
        editor={harness.editor}
        editorReadyToken={1}
        comments={[imported]}
        enabled
      />,
    );

    const zone = document.querySelector('[data-testid="comment-zone-ado-1513151-16261206-1"]');
    expect(zone).toHaveTextContent("Eduardo Fernandez");
    expect(zone).not.toHaveTextContent("you ·");
  });

  it("renders an agent reply above a later reply written in the tile", () => {
    const harness = editorHarness();
    const root: SessionFileComment = { ...comment(), id: "root", created_at: "1786000000" };
    const agentReply: SessionFileComment = {
      ...comment(),
      id: "agent-reply",
      author: "agent",
      parent_id: "root",
      body: "AGENT_ANSWER",
      created_at: "2026-08-17T10:00:00Z",
    };
    const myReply: SessionFileComment = {
      ...comment(),
      id: "my-reply",
      parent_id: "root",
      body: "MY_FOLLOW_UP",
      // The tile historically wrote epoch seconds, which sorted before ISO.
      created_at: String(Math.floor(Date.parse("2026-08-17T11:00:00Z") / 1000)),
    };

    render(
      <FileCommentsLayer
        editor={harness.editor}
        editorReadyToken={1}
        comments={[root, myReply, agentReply]}
        enabled
      />,
    );

    const text = document.querySelector('[data-testid="comment-zone-root"]')?.textContent ?? "";
    expect(text).toContain("AGENT_ANSWER");
    expect(text).toContain("MY_FOLLOW_UP");
    expect(text.indexOf("AGENT_ANSWER")).toBeLessThan(text.indexOf("MY_FOLLOW_UP"));
  });
});
