import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuestionCard, type QuestionCardProps } from "../QuestionCard";
import type { GrillQuestion } from "../../../domain/grill/parse";
import { memoryGrillIo } from "./memory-io";

vi.mock("../../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

afterEach(cleanup);

function question(overrides: Partial<GrillQuestion> = {}): GrillQuestion {
  return {
    round: 1, id: "A1", title: "Layout", section: "A", importance: "Medium", importanceByUser: false, importanceInferred: false,
    context: "", options: [{ key: "a", text: "tabs" }, { key: "b", text: "slides" }],
    visuals: [], visualRequests: [], recommendation: "(b)", answer: "",
    lines: { heading: 0, end: 1, importance: null, recommendation: null, answer: null, answerEnd: null },
    ...overrides,
  };
}

function renderCard(overrides: Partial<QuestionCardProps> = {}) {
  const props: QuestionCardProps = {
    question: question(), answer: "", readOnly: false, alwaysShowRecommendation: false, grillDir: "/f", io: memoryGrillIo(""),
    onAnswer: vi.fn(), onImportance: vi.fn(), onRequestVisual: vi.fn(), ...overrides,
  };
  render(<QuestionCard {...props} />);
  return props;
}

describe("a question card", () => {
  it("keeps the note when switching options", () => {
    const props = renderCard({ answer: "a — on the phone" });
    fireEvent.click(screen.getByTestId("grill-option-b"));
    expect(props.onAnswer).toHaveBeenCalledWith("b — on the phone", true);
  });

  it("marks importance set by you, or missing from the file", () => {
    renderCard({ question: question({ importanceByUser: true }) });
    expect(screen.getByTitle("Set by you")).toBeTruthy();
    cleanup();
    renderCard({ question: question({ importanceInferred: true }) });
    expect(screen.getByTitle("No importance in the file")).toBeTruthy();
  });

  it("shows each option's visuals with it, and side by side on request", () => {
    renderCard({
      question: question({
        visuals: [
          { path: "grill-assets/A1/a.html", label: "Tabs", option: "a" },
          { path: "grill-assets/A1/b.html", label: "Slides", option: "b" },
          { path: "grill-assets/A1/flow.png", label: "Flow", option: null },
        ],
      }),
    });
    const rows = screen.getAllByTestId("grill-option-row");
    expect(rows[0].querySelector("[data-testid=grill-visual]")?.getAttribute("data-path")).toBe("grill-assets/A1/a.html");
    expect(rows[1].querySelector("[data-testid=grill-visual]")?.getAttribute("data-path")).toBe("grill-assets/A1/b.html");
    fireEvent.click(screen.getByTestId("grill-compare"));
    const comparison = screen.getByTestId("grill-comparison");
    expect([...comparison.querySelectorAll("[data-testid=grill-visual]")].map((v) => v.getAttribute("data-path")))
      .toEqual(["grill-assets/A1/a.html", "grill-assets/A1/b.html"]);
    expect(rows[0].querySelector("[data-testid=grill-visual]")).toBeNull();
    fireEvent.click(screen.getByTestId("grill-compare"));
    expect(screen.queryByTestId("grill-comparison")).toBeNull();
  });

  it("lists visual requests still waiting, and can cancel a new one", () => {
    const props = renderCard({ question: question({ visualRequests: ["a diagram"] }) });
    expect(screen.getByTestId("grill-visual-requested").textContent).toContain("a diagram");
    fireEvent.click(screen.getByTestId("grill-request-visual"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("grill-request-note")).toBeNull();
    expect(props.onRequestVisual).not.toHaveBeenCalled();
  });

  it("does not offer the recommendation's accept on a read-only round", () => {
    renderCard({ readOnly: true, alwaysShowRecommendation: true });
    expect(screen.getByTestId("grill-recommendation-text")).toBeTruthy();
    expect(screen.queryByTestId("grill-accept")).toBeNull();
  });

  it("says why a Blocking question has no accept", () => {
    renderCard({ question: question({ importance: "Blocking" }), alwaysShowRecommendation: true });
    expect(screen.getByText("Blocking: this one needs your own answer.")).toBeTruthy();
  });
});
