import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OpenTabsBar, TabSwitcher } from "../OpenTabsBar";
import { emptyTabs, openTab, togglePin } from "../../domain/open-tabs";

afterEach(cleanup);

const state = () => {
  let t = emptyTabs();
  t = openTab(t, "/r/src/a.ts", "keep");
  t = openTab(t, "/r/src/b.md", "keep");
  t = openTab(t, "/r/c.ts", "preview");
  return togglePin(t, "/r/src/a.ts");
};

function setup(shown: string | null = "/r/c.ts") {
  const actions = { onSelect: vi.fn(), onKeep: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onCloseAll: vi.fn(), onTogglePin: vi.fn(), onReveal: vi.fn() };
  render(<OpenTabsBar tabs={state()} shownPath={shown} dirtyPath={"/r/src/b.md"} {...actions} />);
  return actions;
}

describe("OpenTabsBar", () => {
  it("shows each open file by name, the preview in italics, the shown one active", () => {
    setup();
    const tabs = screen.getAllByTestId("open-file-tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["a.ts", "b.md●", "c.ts"]);
    expect(tabs[2]).toHaveAttribute("data-preview", "true");
    expect(tabs[2]).toHaveStyle({ fontStyle: "italic" });
    expect(tabs[2]).toHaveAttribute("data-active", "true");
    expect(tabs[0]).toHaveAttribute("data-pinned", "true");
    expect(tabs[0]).toHaveAttribute("title", "/r/src/a.ts");
  });

  it("no tab is active while browsing", () => {
    setup(null);
    expect(screen.getAllByTestId("open-file-tab").every((t) => t.getAttribute("data-active") === "false")).toBe(true);
  });

  it("click selects, double-click keeps, × and middle-click close", () => {
    const a = setup();
    const tabs = screen.getAllByTestId("open-file-tab");
    fireEvent.click(tabs[1]);
    expect(a.onSelect).toHaveBeenCalledWith("/r/src/b.md");
    fireEvent.doubleClick(tabs[2]);
    expect(a.onKeep).toHaveBeenCalledWith("/r/c.ts");
    fireEvent.click(screen.getAllByTestId("open-file-tab-close")[1]);
    expect(a.onClose).toHaveBeenCalledWith("/r/src/b.md");
    expect(a.onSelect).toHaveBeenCalledTimes(1);
    fireEvent(tabs[0], new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(a.onClose).toHaveBeenCalledWith("/r/src/a.ts");
  });

  it("right-click offers the tab actions", () => {
    const a = setup();
    fireEvent.contextMenu(screen.getAllByTestId("open-file-tab")[1]);
    for (const [label, fn] of [["Close others", a.onCloseOthers], ["Close to the right", a.onCloseRight], ["Pin", a.onTogglePin], ["Reveal in tree", a.onReveal]] as const) {
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(fn).toHaveBeenCalledWith("/r/src/b.md");
      fireEvent.contextMenu(screen.getAllByTestId("open-file-tab")[1]);
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "Close all" }));
    expect(a.onCloseAll).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(screen.getAllByTestId("open-file-tab")[0]);
    expect(screen.getByRole("menuitem", { name: "Unpin" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("TabSwitcher", () => {
  it("lists files most recent first and marks the highlighted one", () => {
    render(<TabSwitcher paths={["/r/z.ts", "/r/y.ts", "/r/x.ts"]} index={1} />);
    const items = screen.getAllByTestId("tab-switcher-item");
    expect(items.map((i) => i.textContent)).toEqual(["z.ts", "y.ts", "x.ts"]);
    expect(items[1]).toHaveAttribute("aria-selected", "true");
  });
});
