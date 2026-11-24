import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useDiffPanelWidth } from "../useDiffPanelWidth";
import { DEFAULT_DIFF_PANEL_WIDTH, loadDiffPanelWidth, saveDiffPanelWidth } from "../diff-panel-width";

function Harness() {
  const { width, containerRef, dividerProps } = useDiffPanelWidth();
  return (
    <div ref={containerRef} data-testid="container">
      <div data-testid="panel" style={{ width }} />
      <div {...dividerProps} />
    </div>
  );
}

function setup(containerLeft = 100, containerWidth = 1000) {
  render(<Harness />);
  const container = screen.getByTestId("container");
  container.getBoundingClientRect = () =>
    ({ left: containerLeft, width: containerWidth, top: 0, height: 400, right: containerLeft + containerWidth, bottom: 400, x: containerLeft, y: 0, toJSON: () => ({}) }) as DOMRect;
  const divider = screen.getByTestId("diff-panel-divider");
  let captured = false;
  divider.setPointerCapture = () => { captured = true; };
  divider.releasePointerCapture = () => { captured = false; };
  divider.hasPointerCapture = () => captured;
  return { divider, panel: screen.getByTestId("panel") };
}

describe("useDiffPanelWidth", () => {
  beforeEach(() => localStorage.clear());

  it("exposes an accessible vertical separator", () => {
    const { divider } = setup();
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("aria-valuenow")).toBe(String(DEFAULT_DIFF_PANEL_WIDTH));
  });

  it("starts from the remembered width", () => {
    saveDiffPanelWidth(260);
    const { panel } = setup();
    expect(panel.style.width).toBe("260px");
  });

  it("follows the pointer while dragging and remembers the result", () => {
    const { divider, panel } = setup(100, 1000);
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 450 });
    expect(panel.style.width).toBe("350px");
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 450 });
    expect(loadDiffPanelWidth()).toBe(350);
  });

  it("ignores pointer moves when no drag is in progress", () => {
    const { divider, panel } = setup();
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 600 });
    expect(panel.style.width).toBe(`${DEFAULT_DIFF_PANEL_WIDTH}px`);
  });

  it("keeps room for the code viewer when dragged too far", () => {
    const { divider, panel } = setup(0, 600);
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 180 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 590 });
    expect(panel.style.width).toBe("400px");
  });

  it("resets to the default width on double-click", () => {
    saveDiffPanelWidth(400);
    const { divider, panel } = setup();
    fireEvent.doubleClick(divider);
    expect(panel.style.width).toBe(`${DEFAULT_DIFF_PANEL_WIDTH}px`);
    expect(loadDiffPanelWidth()).toBe(DEFAULT_DIFF_PANEL_WIDTH);
  });

  it("resizes with the arrow keys", () => {
    const { divider, panel } = setup();
    act(() => { fireEvent.keyDown(divider, { key: "ArrowRight" }); });
    expect(panel.style.width).toBe(`${DEFAULT_DIFF_PANEL_WIDTH + 20}px`);
    act(() => { fireEvent.keyDown(divider, { key: "ArrowLeft" }); });
    act(() => { fireEvent.keyDown(divider, { key: "ArrowLeft" }); });
    expect(panel.style.width).toBe(`${DEFAULT_DIFF_PANEL_WIDTH - 20}px`);
    expect(loadDiffPanelWidth()).toBe(DEFAULT_DIFF_PANEL_WIDTH - 20);
  });
});
