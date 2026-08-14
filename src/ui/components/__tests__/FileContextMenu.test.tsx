import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FileContextMenu } from "../FileContextMenu";

const writeText = vi.fn();
const revealItemInDir = vi.fn();
const dispatch = vi.fn();

vi.mock("../../../domain/clipboard", () => ({
  writeTextToClipboard: (...args: unknown[]) => writeText(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...args: unknown[]) => revealItemInDir(...args),
}));
vi.mock("../../../domain/workbench-events", () => ({
  dispatchAddToWorkbench: (...args: unknown[]) => dispatch(...args),
}));

describe("FileContextMenu", () => {
  beforeEach(() => {
    writeText.mockReset();
    revealItemInDir.mockReset();
    dispatch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all items for a file", () => {
    render(<FileContextMenu x={10} y={20} path="C:/a/b.txt" workstreamId="w1" onClose={() => {}} />);
    expect(screen.getByTestId("ctx-copy-path")).toBeTruthy();
    expect(screen.getByTestId("ctx-copy-name")).toBeTruthy();
    expect(screen.getByTestId("ctx-open-system")).toBeTruthy();
    expect(screen.getByTestId("ctx-add-to-workbench")).toBeTruthy();
  });

  it("hides Add to Workbench when hideAddToWorkbench is true", () => {
    render(<FileContextMenu x={0} y={0} path="C:/a.txt" workstreamId={null} hideAddToWorkbench onClose={() => {}} />);
    expect(screen.queryByTestId("ctx-add-to-workbench")).toBeNull();
  });

  it("hides Add to Workbench for directories and uses folder label", () => {
    render(<FileContextMenu x={0} y={0} path="C:/a" isDir workstreamId={null} onClose={() => {}} />);
    expect(screen.queryByTestId("ctx-add-to-workbench")).toBeNull();
    expect(screen.getByTestId("ctx-copy-name").textContent).toContain("folder");
  });

  it("omits New file / New folder when no create callbacks are provided", () => {
    render(<FileContextMenu x={0} y={0} path="C:/a/b.txt" workstreamId={null} onClose={() => {}} />);
    expect(screen.queryByTestId("ctx-new-file")).toBeNull();
    expect(screen.queryByTestId("ctx-new-folder")).toBeNull();
  });

  it("shows an inline name composer and creates a new file", async () => {
    const onNewFile = vi.fn();
    const onClose = vi.fn();
    render(
      <FileContextMenu
        x={0}
        y={0}
        path="C:/a"
        isDir
        workstreamId={null}
        onClose={onClose}
        onNewFile={onNewFile}
      />,
    );
    fireEvent.click(screen.getByTestId("ctx-new-file"));
    fireEvent.change(screen.getByTestId("ctx-create-name"), {
      target: { value: "notes.md" },
    });
    fireEvent.click(screen.getByTestId("ctx-create-save"));
    await waitFor(() => expect(onNewFile).toHaveBeenCalledWith("notes.md"));
    expect(onClose).toHaveBeenCalled();
  });

  it("creates a new folder from the inline composer", async () => {
    const onNewFolder = vi.fn();
    render(
      <FileContextMenu
        x={0}
        y={0}
        path="C:/a"
        isDir
        workstreamId={null}
        onClose={() => {}}
        onNewFolder={onNewFolder}
      />,
    );
    fireEvent.click(screen.getByTestId("ctx-new-folder"));
    fireEvent.change(screen.getByTestId("ctx-create-name"), {
      target: { value: "assets" },
    });
    fireEvent.click(screen.getByTestId("ctx-create-save"));
    await waitFor(() => expect(onNewFolder).toHaveBeenCalledWith("assets"));
  });

  it("fires copy-path and closes", () => {
    const onClose = vi.fn();
    render(<FileContextMenu x={0} y={0} path="C:/a/b.txt" workstreamId="w1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("ctx-copy-path"));
    expect(writeText).toHaveBeenCalledWith("C:/a/b.txt");
    expect(onClose).toHaveBeenCalled();
  });

  it("fires copy-name with basename", () => {
    render(<FileContextMenu x={0} y={0} path="C:/a/b.txt" workstreamId="w1" onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("ctx-copy-name"));
    expect(writeText).toHaveBeenCalledWith("b.txt");
  });

  it("fires open-system", async () => {
    render(<FileContextMenu x={0} y={0} path="C:/a/b.txt" workstreamId="w1" onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("ctx-open-system"));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("C:/a/b.txt"));
  });

  it("surfaces open-system errors instead of silently closing", async () => {
    revealItemInDir.mockRejectedValueOnce(new Error("opener denied"));
    const onClose = vi.fn();
    render(<FileContextMenu x={0} y={0} path="C:/a/b.txt" workstreamId="w1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("ctx-open-system"));
    expect((await screen.findByTestId("ctx-action-error")).textContent).toContain("opener denied");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("fires add-to-workbench with workstreamId", () => {
    render(<FileContextMenu x={0} y={0} path="C:/a/b.txt" workstreamId="w1" onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("ctx-add-to-workbench"));
    expect(dispatch).toHaveBeenCalledWith({ path: "C:/a/b.txt", workstreamId: "w1" });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<FileContextMenu x={0} y={0} path="C:/a.txt" workstreamId={null} onClose={onClose} />);
    await new Promise((r) => setTimeout(r, 5));
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(onClose).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes on outside mousedown", async () => {
    const onClose = vi.fn();
    render(<FileContextMenu x={0} y={0} path="C:/a.txt" workstreamId={null} onClose={onClose} />);
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("clamps the measured menu inside the viewport", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 220,
      height: 300,
      top: 0,
      left: 0,
      right: 220,
      bottom: 300,
      toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    render(<FileContextMenu x={780} y={590} path="C:/a.txt" workstreamId={null} onClose={() => {}} />);
    const menu = screen.getByTestId("file-context-menu");
    await waitFor(() => expect(menu.style.left).toBe("572px"));
    expect(menu.style.top).toBe("292px");
  });
});
