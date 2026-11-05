import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AcceptanceCard, type AcceptanceCardProps } from "../AcceptanceCard";
import { parseAcceptance } from "../../../domain/acceptance/parse";
import { memoryAcceptanceIo } from "./memory-io";

vi.mock("../../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
afterEach(cleanup);

const parse = (text: string) => parseAcceptance(text).tests[0];

function renderCard(overrides: Partial<AcceptanceCardProps> = {}) {
  const props: AcceptanceCardProps = {
    test: parse("## AT-1 — Title\n**Validates:** US-1\n**Automation:** agent\n\n**Given** g\n**When** w\n**Then** t\n"),
    readOnly: false, featureDir: "/f", io: memoryAcceptanceIo(""), rounds: [],
    onMark: vi.fn(), onRequestVisual: vi.fn(), ...overrides,
  };
  render(<AcceptanceCard {...props} />);
  return props;
}

describe("an acceptance card", () => {
  it("shows the current mark and the change note", () => {
    renderCard({ test: parse("## AT-1 — T\n**Review:** change: say which toast\n") });
    expect(screen.getByTestId("acceptance-card-mark").textContent).toBe("Needs change");
    expect(screen.getByText("Needs change: say which toast")).toBeTruthy();
  });

  it("can't save an empty change note", () => {
    const props = renderCard();
    fireEvent.click(screen.getByTestId("acceptance-mark-change"));
    expect((screen.getByTestId("acceptance-change-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("acceptance-change-note"), { target: { value: "more" } });
    fireEvent.click(screen.getByTestId("acceptance-change-save"));
    expect(props.onMark).toHaveBeenCalledWith({ kind: "change", note: "more" });
  });

  it("cancels a visual request without sending it", () => {
    const props = renderCard();
    fireEvent.click(screen.getByTestId("acceptance-request-visual"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("acceptance-request-note")).toBeNull();
    expect(props.onRequestVisual).not.toHaveBeenCalled();
  });

  it("offers no clear on an unmarked test, and no storyboard without frames", () => {
    renderCard();
    expect((screen.getByTestId("acceptance-mark-clear") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("acceptance-storyboard")).toBeNull();
    expect(screen.getByText("Validates US-1")).toBeTruthy();
  });

  it("shows each step's frames full width right after that step's text, and unstepped frames after Then", () => {
    renderCard({ test: parse([
      "## AT-1 — T", "**Given** the form", "**When** pressing Save", "**Then** a toast",
      '**Frame:** acceptance-assets/AT-1/1.html "Form" (given)',
      '**Frame:** acceptance-assets/AT-1/2.html "Press" (when)',
      '**Frame:** acceptance-assets/AT-1/x.html "Extra"',
      '**Frame:** acceptance-assets/AT-1/3.html "Toast" (then)',
      "**Passes when:** it shows",
    ].join("\n")) });
    const card = screen.getByTestId("acceptance-card");
    const order = [...card.querySelectorAll('[data-testid="md"], [data-testid="acceptance-frame"]')]
      .map((el) => (el.getAttribute("data-testid") === "md" ? el.textContent : `frame:${within(el as HTMLElement).getByTestId("acceptance-frame-caption").textContent}`));
    expect(order).toEqual(["the form", "frame:Form", "pressing Save", "frame:Press", "a toast", "frame:Toast", "frame:Extra", "it shows"]);
    for (const board of screen.getAllByTestId("acceptance-storyboard")) {
      expect(board.style.gridTemplateColumns).toBe("");
    }
  });
});
