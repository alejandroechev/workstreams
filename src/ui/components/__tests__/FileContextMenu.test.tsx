import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileContextMenu } from "../FileContextMenu";

const writeText = vi.fn();
const openPath = vi.fn();
const dispatch = vi.fn();

vi.mock("../../../domain/clipboard", () => ({
  writeTextToClipboard: (...args: unknown[]) => writeText(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (...args: unknown[]) => { openPath(...args); return Promise.resolve(); },
}));
vi.mock("../../../domain/workbench-events", () => ({
  dispatchAddToWorkbench: (...args: unknown[]) => dispatch(...args),
}));

describe("FileContextMenu", () => {
  beforeEach(() => {
    writeText.mockReset();
    openPath.mockReset();
    dispatch.mockReset();
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

  it("fires open-system", () => {
    render(<FileContextMenu x={0} y={0} path="C:/a/b.txt" workstreamId="w1" onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("ctx-open-system"));
    expect(openPath).toHaveBeenCalledWith("C:/a/b.txt");
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
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on outside mousedown", async () => {
    const onClose = vi.fn();
    render(<FileContextMenu x={0} y={0} path="C:/a.txt" workstreamId={null} onClose={onClose} />);
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
