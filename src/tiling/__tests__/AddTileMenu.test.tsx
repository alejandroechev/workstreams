import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AddTileMenu from "../AddTileMenu";

describe("AddTileMenu", () => {
  afterEach(() => cleanup());

  const makeItems = () => [
    { key: "session", label: "Copilot Session", icon: "session" as const, shortcut: "Alt+S", onSelect: vi.fn() },
    { key: "terminal", label: "Terminal", icon: "terminal" as const, onSelect: vi.fn() },
    { key: "explorer", label: "File Explorer", icon: "folder" as const, onSelect: vi.fn() },
  ];

  it("renders the trigger button with label", () => {
    render(<AddTileMenu items={makeItems()} />);
    expect(screen.getByTestId("add-tile-button")).toBeTruthy();
    expect(screen.getByText("Add tile")).toBeTruthy();
  });

  it("opens the menu on click and shows all items", () => {
    render(<AddTileMenu items={makeItems()} />);
    fireEvent.click(screen.getByTestId("add-tile-button"));
    expect(screen.getByTestId("add-tile-menu")).toBeTruthy();
    expect(screen.getByText("Copilot Session")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("File Explorer")).toBeTruthy();
  });

  it("calls onSelect and closes when an item is clicked", () => {
    const items = makeItems();
    render(<AddTileMenu items={items} />);
    fireEvent.click(screen.getByTestId("add-tile-button"));
    fireEvent.click(screen.getByTestId("add-tile-item-terminal"));
    expect(items[1].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("add-tile-menu")).toBeFalsy();
  });

  it("closes on Escape", () => {
    render(<AddTileMenu items={makeItems()} />);
    fireEvent.click(screen.getByTestId("add-tile-button"));
    expect(screen.getByTestId("add-tile-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("add-tile-menu")).toBeFalsy();
  });

  it("navigates with arrow keys and selects with Enter", () => {
    const items = makeItems();
    render(<AddTileMenu items={items} />);
    fireEvent.click(screen.getByTestId("add-tile-button"));
    // Default highlight is item 0; ArrowDown twice -> item 2; Enter selects it
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(items[2].onSelect).toHaveBeenCalledTimes(1);
  });

  it("wraps arrow navigation around the ends", () => {
    const items = makeItems();
    render(<AddTileMenu items={items} />);
    fireEvent.click(screen.getByTestId("add-tile-button"));
    // ArrowUp from item 0 wraps to item N-1
    fireEvent.keyDown(document, { key: "ArrowUp" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(items[items.length - 1].onSelect).toHaveBeenCalledTimes(1);
  });

  it("closes when clicking outside", () => {
    render(
      <div>
        <button data-testid="outside">outside</button>
        <AddTileMenu items={makeItems()} />
      </div>
    );
    fireEvent.click(screen.getByTestId("add-tile-button"));
    expect(screen.getByTestId("add-tile-menu")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("add-tile-menu")).toBeFalsy();
  });
});
