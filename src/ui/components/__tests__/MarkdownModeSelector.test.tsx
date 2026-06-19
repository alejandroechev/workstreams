import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownModeSelector } from "../MarkdownModeSelector";
import type { MarkdownViewState } from "../../../files/FileEditorView";

function makeViewState(over: Partial<MarkdownViewState> = {}): MarkdownViewState {
  return {
    mode: "preview",
    setMode: vi.fn(),
    toggle: vi.fn(),
    canPresent: true,
    enterPresent: vi.fn(),
    exitPresent: vi.fn(),
    slideIndex: 0,
    setSlideIndex: vi.fn(),
    ...over,
  };
}

afterEach(() => cleanup());

describe("MarkdownModeSelector", () => {
  it("renders Edit / Preview / Slides segments for presentable files", () => {
    render(<MarkdownModeSelector viewState={makeViewState()} testIdPrefix="t" />);
    expect(screen.getByTestId("t-mode-edit")).toBeInTheDocument();
    expect(screen.getByTestId("t-mode-preview")).toBeInTheDocument();
    expect(screen.getByTestId("t-present-toggle")).toBeInTheDocument();
  });

  it("hides the Slides segment when the file cannot be presented", () => {
    render(<MarkdownModeSelector viewState={makeViewState({ canPresent: false })} testIdPrefix="t" />);
    expect(screen.getByTestId("t-mode-edit")).toBeInTheDocument();
    expect(screen.getByTestId("t-mode-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("t-present-toggle")).toBeNull();
  });

  it("calls setMode with the chosen mode on click", () => {
    const vs = makeViewState();
    render(<MarkdownModeSelector viewState={vs} testIdPrefix="t" />);
    fireEvent.click(screen.getByTestId("t-mode-edit"));
    expect(vs.setMode).toHaveBeenCalledWith("edit");
    fireEvent.click(screen.getByTestId("t-present-toggle"));
    expect(vs.setMode).toHaveBeenCalledWith("present");
  });

  it("marks the active segment via aria-checked", () => {
    render(<MarkdownModeSelector viewState={makeViewState({ mode: "present" })} testIdPrefix="t" />);
    expect(screen.getByTestId("t-present-toggle")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("t-mode-preview")).toHaveAttribute("aria-checked", "false");
  });
});
