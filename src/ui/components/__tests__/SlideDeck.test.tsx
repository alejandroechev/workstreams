import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SlideDeck } from "../SlideDeck";

// Render markdown content as plain text so we can assert which slide shows.
vi.mock("../../MarkdownView", () => ({
  MarkdownView: ({ children, baseFontSize }: { children: string; baseFontSize?: number }) => (
    <div data-testid="md" data-font={baseFontSize}>{children}</div>
  ),
}));

const DECK = "# One\n\n---\n\n# Two\n\n---\n\n# Three";

describe("SlideDeck — rendering", () => {
  it("renders the deck container and the slide at the given index", () => {
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={() => {}} />);
    expect(screen.getByTestId("slide-deck")).toBeTruthy();
    const content = screen.getByTestId("slide-content");
    expect(content.textContent).toContain("# Two");
    expect(content.textContent).not.toContain("# One");
  });

  it("clamps an out-of-range index to the last slide", () => {
    render(<SlideDeck source={DECK} slideIndex={99} onIndexChange={() => {}} />);
    expect(screen.getByTestId("slide-content").textContent).toContain("# Three");
  });

  it("clamps a negative index to the first slide", () => {
    render(<SlideDeck source={DECK} slideIndex={-5} onIndexChange={() => {}} />);
    expect(screen.getByTestId("slide-content").textContent).toContain("# One");
  });

  it("applies the deck fontScale from frontmatter to the base font size", () => {
    render(
      <SlideDeck
        source={"---\nfontScale: 2\n---\n# Big"}
        slideIndex={0}
        baseFontSize={20}
        onIndexChange={() => {}}
      />,
    );
    const md = screen.getByTestId("md");
    expect(md.getAttribute("data-font")).toBe("40");
  });

  it("renders a single empty slide for a blank document without crashing", () => {
    render(<SlideDeck source={"   "} slideIndex={0} onIndexChange={() => {}} />);
    expect(screen.getByTestId("slide-content")).toBeTruthy();
  });

  it("reports a clamped index back via onIndexChange when the persisted index is out of range", () => {
    // Simulates a deck that shrank (e.g. after an edit/hot-reload) leaving a
    // persisted slideIndex past the end — SlideDeck clamps and notifies.
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={10} onIndexChange={onIndexChange} />);
    expect(onIndexChange).toHaveBeenCalledWith(2);
  });

  it("does not report back when the index is already in range", () => {
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={onIndexChange} />);
    expect(onIndexChange).not.toHaveBeenCalled();
  });
});

describe("SlideDeck — navigation", () => {
  it("advances on ArrowRight / Space / PageDown", () => {
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={0} onIndexChange={onIndexChange} />);
    const deck = screen.getByTestId("slide-deck");
    fireEvent.keyDown(deck, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(deck, { key: " " });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(deck, { key: "PageDown" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });

  it("goes back on ArrowLeft / PageUp", () => {
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={2} onIndexChange={onIndexChange} />);
    const deck = screen.getByTestId("slide-deck");
    fireEvent.keyDown(deck, { key: "ArrowLeft" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(deck, { key: "PageUp" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });

  it("jumps to first/last with Home/End", () => {
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={onIndexChange} />);
    const deck = screen.getByTestId("slide-deck");
    fireEvent.keyDown(deck, { key: "End" });
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(deck, { key: "Home" });
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
  });

  it("does not advance past the last slide or before the first", () => {
    const onIndexChange = vi.fn();
    const { rerender } = render(<SlideDeck source={DECK} slideIndex={2} onIndexChange={onIndexChange} />);
    fireEvent.keyDown(screen.getByTestId("slide-deck"), { key: "ArrowRight" });
    expect(onIndexChange).not.toHaveBeenCalled();
    rerender(<SlideDeck source={DECK} slideIndex={0} onIndexChange={onIndexChange} />);
    fireEvent.keyDown(screen.getByTestId("slide-deck"), { key: "ArrowLeft" });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("does not handle Escape (reserved for the host)", () => {
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={onIndexChange} />);
    fireEvent.keyDown(screen.getByTestId("slide-deck"), { key: "Escape" });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("advances when clicking the right half and goes back on the left half", () => {
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={onIndexChange} />);
    const nav = screen.getByTestId("slide-click-layer");
    // jsdom has no layout; stub getBoundingClientRect for half detection.
    nav.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(nav, { clientX: 800 });
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(nav, { clientX: 100 });
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
  });
});

describe("SlideDeck — controls", () => {
  it("shows an 'n / N' slide counter", () => {
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={() => {}} />);
    expect(screen.getByTestId("slide-counter").textContent?.replace(/\s/g, "")).toBe("2/3");
  });

  it("reflects position in the progress bar width", () => {
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={() => {}} />);
    // (index+1)/N = 2/3 ≈ 66.7%
    const bar = screen.getByTestId("slide-progress");
    expect(bar.style.width.startsWith("66.7")).toBe(true);
  });

  it("prev/next control buttons navigate", () => {
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={onIndexChange} />);
    fireEvent.click(screen.getByTestId("slide-next"));
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByTestId("slide-prev"));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
  });

  it("control buttons do not also trigger click-to-advance", () => {
    const onIndexChange = vi.fn();
    render(<SlideDeck source={DECK} slideIndex={1} onIndexChange={onIndexChange} />);
    fireEvent.click(screen.getByTestId("slide-next"));
    // Exactly one navigation call (next), not a second from the click layer.
    expect(onIndexChange).toHaveBeenCalledTimes(1);
  });

  it("fullscreen button calls onToggleFullscreen", () => {
    const onToggleFullscreen = vi.fn();
    render(
      <SlideDeck source={DECK} slideIndex={0} onIndexChange={() => {}} onToggleFullscreen={onToggleFullscreen} />,
    );
    fireEvent.click(screen.getByTestId("slide-fullscreen"));
    expect(onToggleFullscreen).toHaveBeenCalled();
  });

  it("omits the fullscreen button when onToggleFullscreen is not provided", () => {
    render(<SlideDeck source={DECK} slideIndex={0} onIndexChange={() => {}} />);
    expect(screen.queryByTestId("slide-fullscreen")).toBeNull();
  });
});
