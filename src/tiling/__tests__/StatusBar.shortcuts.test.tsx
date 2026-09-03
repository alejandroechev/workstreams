import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import StatusBar from "../StatusBar";
import { _setFeatureFlagOverrideForTests } from "../../domain/feature-flags";
import { shortcutLabel, supportsWsl } from "../../domain/platform";

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
    onAddLoop: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onToggleSideBySide: vi.fn(),
    onOpenSettings: vi.fn(),
  };
}

function openAddTileMenu() {
  fireEvent.click(screen.getByTestId("add-tile-button"));
}

describe("StatusBar add-tile shortcut labels", () => {
  it("renders the same shortcut label for every visible entry", () => {
    _setFeatureFlagOverrideForTests(true);
    render(<StatusBar {...commonProps()} />);
    openAddTileMenu();

    const expected: Array<[string, string]> = [
      ["session", "C"],
      ["terminal", "T"],
      ["explorer", "R"],
      ["meta", "M"],
      ["workbench", "B"],
      ["plan", "P"],
      ["code-review", "A"],
      ["walkthrough", "D"],
      ["loop", "L"],
    ];
    if (supportsWsl()) expected.splice(2, 0, ["wsl", "W"]);

    for (const [key, letter] of expected) {
      expect(screen.getByTestId(`add-tile-item-${key}`).textContent).toContain(
        shortcutLabel(letter),
      );
    }
  });

  it("keeps the menu entries in their original order", () => {
    _setFeatureFlagOverrideForTests(true);
    render(<StatusBar {...commonProps()} />);
    openAddTileMenu();

    const order = ["session", "terminal", "wsl", "explorer", "meta", "workbench", "plan", "code-review", "walkthrough", "loop"]
      .filter((key) => key !== "wsl" || supportsWsl());
    const rendered = order.map((key) => screen.getByTestId(`add-tile-item-${key}`));
    const sorted = [...rendered].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    expect(sorted).toEqual(rendered);
  });

  it("drops entries with no onSelect handler", () => {
    _setFeatureFlagOverrideForTests(true);
    render(<StatusBar {...commonProps()} onAddLoop={undefined} />);
    openAddTileMenu();
    expect(screen.queryByTestId("add-tile-item-loop")).toBeNull();
  });

  it("hides WSL when the platform does not support it", () => {
    _setFeatureFlagOverrideForTests(true);
    render(<StatusBar {...commonProps()} />);
    openAddTileMenu();
    if (supportsWsl()) {
      expect(screen.getByTestId("add-tile-item-wsl")).toBeTruthy();
    } else {
      expect(screen.queryByTestId("add-tile-item-wsl")).toBeNull();
    }
  });
});
