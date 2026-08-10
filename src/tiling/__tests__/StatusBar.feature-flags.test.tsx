import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import StatusBar from "../StatusBar";
import { _setFeatureFlagOverrideForTests } from "../../domain/feature-flags";

afterEach(() => {
  cleanup();
  _setFeatureFlagOverrideForTests(null);
});

function commonProps() {
  return {
    tileCount: 0,
    focusedLabel: "",
    fullscreen: false,
    sideBySide: false,
    canEnterSideBySide: false,
    onAddSession: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddWslTerminal: vi.fn(),
    onAddExplorer: vi.fn(),
    onAddSessionMeta: vi.fn(),
    onAddWorkbench: vi.fn(),
    onAddPlan: vi.fn(),
    onAddCodeReview: vi.fn(),
    onAddWalkthrough: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onToggleSideBySide: vi.fn(),
    onOpenSettings: vi.fn(),
  };
}

function openAddTileMenu() {
  fireEvent.click(screen.getByTestId("add-tile-button"));
}

describe("StatusBar feature-flag gating", () => {
  it("hides the Plan menu entry when its flag is off", () => {
    _setFeatureFlagOverrideForTests(false);
    render(<StatusBar {...commonProps()} />);
    openAddTileMenu();
    expect(screen.queryByTestId("add-tile-item-plan")).toBeNull();
    // Sanity: other entries still render.
    expect(screen.getByTestId("add-tile-item-explorer")).toBeTruthy();
    expect(screen.getByTestId("add-tile-item-session")).toBeTruthy();
    // Code Review is not flag-gated.
    expect(screen.getByTestId("add-tile-item-code-review")).toBeTruthy();
    // The walkthrough ships disabled, like Plan.
    expect(screen.queryByTestId("add-tile-item-walkthrough")).toBeNull();
  });

  it("shows the Code Walkthrough entry when its flag is on", () => {
    _setFeatureFlagOverrideForTests(true);
    render(<StatusBar {...commonProps()} />);
    openAddTileMenu();
    expect(screen.getByTestId("add-tile-item-walkthrough")).toBeTruthy();
  });

  it("shows the Plan menu entry when the flag is on", () => {
    _setFeatureFlagOverrideForTests(true);
    render(<StatusBar {...commonProps()} />);
    openAddTileMenu();
    expect(screen.getByTestId("add-tile-item-plan")).toBeTruthy();
  });
});
