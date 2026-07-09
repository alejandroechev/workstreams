import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import StatusBar from "../StatusBar";

function commonProps(overrides: Record<string, unknown> = {}) {
  return {
    tileCount: 0,
    focusedLabel: "none",
    fullscreen: false,
    sideBySide: false,
    canEnterSideBySide: false,
    sbsSelectionMode: false,
    onAddTerminal: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onToggleSideBySide: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

describe("StatusBar disabled state (no workstream selected)", () => {
  afterEach(() => cleanup());

  it("disables Add-tile, side-by-side and fullscreen when disabled", () => {
    render(<StatusBar {...commonProps({ disabled: true })} />);
    expect((screen.getByTestId("add-tile-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("toggle-sbs") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("toggle-fullscreen") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not invoke handlers when the disabled controls are clicked", () => {
    const onToggleSideBySide = vi.fn();
    const onToggleFullscreen = vi.fn();
    render(
      <StatusBar {...commonProps({ disabled: true, onToggleSideBySide, onToggleFullscreen })} />,
    );
    fireEvent.click(screen.getByTestId("toggle-sbs"));
    fireEvent.click(screen.getByTestId("toggle-fullscreen"));
    expect(onToggleSideBySide).not.toHaveBeenCalled();
    expect(onToggleFullscreen).not.toHaveBeenCalled();
  });

  it("enables all three controls when a workstream is selected (not disabled)", () => {
    render(<StatusBar {...commonProps({ disabled: false })} />);
    expect((screen.getByTestId("add-tile-button") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("toggle-sbs") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("toggle-fullscreen") as HTMLButtonElement).disabled).toBe(false);
  });
});
