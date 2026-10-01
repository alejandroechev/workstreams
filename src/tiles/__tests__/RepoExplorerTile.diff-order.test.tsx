import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
import { fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";

import RepoExplorerTile from "../RepoExplorerTile";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";

const h = vi.hoisted(() => ({
  lastOptions: null as null | { renderSideBySide?: boolean },
  hiddenAreas: [] as Array<Array<{ startLineNumber: number; endLineNumber: number }>>,
  lineCount: 100,
  originalOptions: [] as Array<{ lineNumbers?: string }>,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

// Monaco stand-in: records options and the hidden line ranges the tile asks for.
vi.mock("@monaco-editor/react", () => ({
  Editor: () => <div data-testid="editor-stub" />,
  DiffEditor: (props: {
    onMount?: (editor: unknown, monaco: unknown) => void;
    options?: { renderSideBySide?: boolean };
  }) => {
    const modifiedRef = useRef<Record<string, unknown> | null>(null);
    const mountedRef = useRef(false);
    h.lastOptions = props.options ?? null;
    if (!modifiedRef.current) {
      modifiedRef.current = {
        onDidChangeModelContent: () => {},
        onDidChangeCursorSelection: () => ({ dispose: () => {} }),
        addCommand: () => {},
        getModel: () => ({ getValue: () => "", setValue: () => {}, getLineCount: () => h.lineCount }),
        hasTextFocus: () => false,
        changeViewZones: () => {},
        getContainerDomNode: () => document.createElement("div"),
        revealLineInCenter: () => {},
        setPosition: () => {},
        setHiddenAreas: (ranges: Array<{ startLineNumber: number; endLineNumber: number }>) => {
          h.hiddenAreas.push(ranges);
        },
      };
    }
    const modified = modifiedRef.current;
    if (!mountedRef.current) {
      mountedRef.current = true;
      props.onMount?.(
        {
          getModifiedEditor: () => modified,
          getOriginalEditor: () => ({
            updateOptions: (options: { lineNumbers?: string }) => h.originalOptions.push(options),
          }),
        },
        { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } },
      );
    }
    return <div data-testid="diff-editor-stub" />;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    h.listeners.set(name, handler);
    return () => h.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const FILES = ["src/b/a.ts", "src/a/z.ts", "README.md", "src/c.ts"];

async function setup(
  order: { paths: string[]; freshness: "current" | "content_changed" | "files_changed" } | null,
  sides: (file: string) => { before: string; after: string } = () => ({ before: "x\n", after: "y\n" }),
) {
  const backend = new MemoryBackend();
  backend.gitDiffFilesWithStatus = async () => FILES.map((path) => ({ path, status: "M" as const }));
  backend.gitDiffFileSides = async (_root, file) => sides(file);
  backend.seedDiffOrder("ws-1", "unstaged", null, order);
  render(
    <BackendProvider backend={backend}>
      <RepoExplorerTile tileId="t1" isFocused rootDir="/repo" workstreamId="ws-1" />
    </BackendProvider>,
  );
  fireEvent.click(await screen.findByTestId("repo-explorer-tab-diff"));
  await screen.findByTestId("diff-editor-stub");
  await waitFor(() => expect(screen.getAllByTestId("diff-file-item")).toHaveLength(FILES.length));
  return backend;
}

const rows = () => screen.getAllByTestId("diff-file-item");
const rowPaths = () => rows().map((row) => row.getAttribute("title"));
const rowPositions = () =>
  rows().map((row) => within(row).queryByTestId("diff-file-position")?.textContent ?? null);
const sortButton = (name: "Recommended" | "Name") =>
  screen.getByTestId(`diff-sort-${name.toLowerCase()}`);
const RECOMMENDED = ["src/c.ts", "README.md", "src/b/a.ts", "src/a/z.ts"];

describe("Repo Explorer diff: recommended reading order", () => {
  beforeEach(() => {
    h.hiddenAreas.length = 0;
    h.originalOptions.length = 0;
    h.listeners.clear();
  });
  afterEach(cleanup);

  it("opens on the recommended order, numbered, with its first file selected", async () => {
    await setup({ paths: RECOMMENDED, freshness: "current" });
    await waitFor(() => expect(rowPaths()).toEqual(RECOMMENDED));
    expect(rowPositions()).toEqual(["1", "2", "3", "4"]);
    expect(sortButton("Recommended")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("diff-current-file")).toHaveTextContent("c.ts");
    expect(screen.queryByTestId("diff-order-stale")).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-order-edited")).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-order-hint")).not.toBeInTheDocument();
  });

  it("sorts by full path for Name, and forgets that choice when the diff reloads", async () => {
    await setup({ paths: RECOMMENDED, freshness: "current" });
    fireEvent.click(sortButton("Name"));
    expect(rowPaths()).toEqual(["README.md", "src/a/z.ts", "src/b/a.ts", "src/c.ts"]);
    expect(rowPositions()).toEqual([null, null, null, null]);
    fireEvent.click(screen.getByText("Last Commit"));
    fireEvent.click(screen.getByText("Unstaged"));
    await waitFor(() => expect(sortButton("Recommended")).toHaveAttribute("aria-pressed", "true"));
    expect(rowPaths()).toEqual(RECOMMENDED);
  });

  it("offers only Name, and says how to get an order, when there is none", async () => {
    await setup(null);
    expect(sortButton("Name")).toHaveAttribute("aria-pressed", "true");
    expect(sortButton("Recommended")).toBeDisabled();
    expect(rowPaths()).toEqual(["README.md", "src/a/z.ts", "src/b/a.ts", "src/c.ts"]);
    expect(screen.getByTestId("diff-order-hint")).toHaveTextContent("order my diff");
  });

  it("keeps using an order whose content changed, with a subtle marker", async () => {
    await setup({ paths: RECOMMENDED, freshness: "content_changed" });
    await waitFor(() => expect(rowPaths()).toEqual(RECOMMENDED));
    expect(screen.getByTestId("diff-order-edited").getAttribute("title")).toMatch(/content has changed/i);
    expect(screen.queryByTestId("diff-order-stale")).not.toBeInTheDocument();
  });

  it("degrades an order whose files changed and flags it stale", async () => {
    await setup({ paths: ["src/c.ts", "gone.ts", "README.md"], freshness: "files_changed" });
    await waitFor(() => expect(rowPaths()).toEqual(["src/c.ts", "README.md", "src/a/z.ts", "src/b/a.ts"]));
    expect(rowPositions()).toEqual(["1", "2", "3", "4"]);
    const stale = screen.getByTestId("diff-order-stale");
    expect(stale).toHaveTextContent(/stale/i);
    expect(stale.getAttribute("title")).toMatch(/added to or removed/i);
    expect(stale.getAttribute("title")).toContain("order my diff");
  });

  // D4: a filter hides rows; it must not renumber the ones it keeps.
  it("keeps positions when the Code comments filter hides rows", async () => {
    await setup({ paths: RECOMMENDED, freshness: "current" }, (file) =>
      file === "README.md" || file === "src/a/z.ts"
        ? { before: "x\n", after: file === "README.md" ? "<!-- why -->\n" : "// why\n" }
        : { before: "x\n", after: "y\n" },
    );
    fireEvent.click(screen.getByTestId("repo-explorer-diff-code-comments"));
    await waitFor(() => expect(rowPaths()).toEqual(["README.md", "src/a/z.ts"]));
    expect(rowPositions()).toEqual(["2", "4"]);
  });

  it("picks up an order the agent saves while the diff is open", async () => {
    const backend = await setup(null);
    backend.seedDiffOrder("ws-1", "unstaged", null, { paths: RECOMMENDED, freshness: "current" });
    h.listeners.get("state-changed")?.({ payload: { entity: "diff_order", id: "ws-1" } });
    await waitFor(() => expect(rowPaths()).toEqual(RECOMMENDED));
    expect(screen.queryByTestId("diff-order-hint")).not.toBeInTheDocument();
  });

  it("ignores state changes for other workstreams", async () => {
    const backend = await setup(null);
    backend.seedDiffOrder("ws-1", "unstaged", null, { paths: RECOMMENDED, freshness: "current" });
    h.listeners.get("state-changed")?.({ payload: { entity: "diff_order", id: "ws-other" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sortButton("Name")).toHaveAttribute("aria-pressed", "true");
  });
});
