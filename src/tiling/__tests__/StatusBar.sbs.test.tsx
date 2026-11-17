import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import StatusBar from "../StatusBar";

function commonProps(overrides: Record<string, unknown> = {}) {
  return {
    tileCount: 4,
    focusedLabel: "Repo Explorer",
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

describe("StatusBar side-by-side button", () => {
  afterEach(() => cleanup());

  it("is always enabled (no longer disabled when no tiles are selected)", () => {
    const onToggleSideBySide = vi.fn();
    render(<StatusBar {...commonProps({ onToggleSideBySide })} />);
    const btn = screen.getByTestId("toggle-sbs") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onToggleSideBySide).toHaveBeenCalledOnce();
  });

  it("highlights when selection mode is on (yellow)", () => {
    render(<StatusBar {...commonProps({ sbsSelectionMode: true, onToggleSideBySide: vi.fn() })} />);
    const btn = screen.getByTestId("toggle-sbs") as HTMLButtonElement;
    expect(btn.style.color).toBe("rgb(249, 226, 175)");
    expect(btn.title).toContain("Cancel side-by-side selection");
  });

  it("highlights when SBS is active (purple) and offers exit tooltip", () => {
    render(<StatusBar {...commonProps({ sideBySide: true, onToggleSideBySide: vi.fn() })} />);
    const btn = screen.getByTestId("toggle-sbs") as HTMLButtonElement;
    expect(btn.style.color).toBe("rgb(203, 166, 247)");
    expect(btn.title).toContain("Exit side-by-side");
  });

  it("default tooltip when idle: 'Pick two tiles for side-by-side'", () => {
    render(<StatusBar {...commonProps({ onToggleSideBySide: vi.fn() })} />);
    const btn = screen.getByTestId("toggle-sbs") as HTMLButtonElement;
    expect(btn.title).toContain("Pick two tiles");
  });
});

describe("StatusBar horizontal side-by-side button", () => {
  afterEach(() => cleanup());

  it("sits next to the vertical one and toggles the stacked split", () => {
    const onToggleSideBySideHorizontal = vi.fn();
    render(<StatusBar {...commonProps({ onToggleSideBySideHorizontal })} />);
    const btn = screen.getByTestId("toggle-sbs-horizontal");
    expect(btn.previousElementSibling?.getAttribute("data-testid")).toBe("toggle-sbs");
    expect(btn.getAttribute("title")).toMatch(/one above the other/);
    fireEvent.click(btn);
    expect(onToggleSideBySideHorizontal).toHaveBeenCalledOnce();
  });

  it("only the active orientation's button is highlighted", () => {
    render(<StatusBar {...commonProps({ sideBySide: true, sideBySideOrientation: "horizontal", onToggleSideBySideHorizontal: vi.fn() })} />);
    expect(screen.getByTestId("toggle-sbs-horizontal").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("toggle-sbs").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("toggle-sbs-horizontal").getAttribute("title")).toMatch(/Exit/);
    expect(screen.getByText(/Stacked/)).toBeTruthy();
  });

  it("is disabled without a workstream", () => {
    const onToggleSideBySideHorizontal = vi.fn();
    render(<StatusBar {...commonProps({ disabled: true, onToggleSideBySideHorizontal })} />);
    fireEvent.click(screen.getByTestId("toggle-sbs-horizontal"));
    expect(onToggleSideBySideHorizontal).not.toHaveBeenCalled();
  });
});
