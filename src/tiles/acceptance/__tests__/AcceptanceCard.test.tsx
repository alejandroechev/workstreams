import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
