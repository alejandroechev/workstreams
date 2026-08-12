import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as MonacoNs from "monaco-editor";

import { FileCommentsLayer } from "../FileCommentsLayer";
import type { SessionFileComment } from "../../domain/file-comments";

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
});
