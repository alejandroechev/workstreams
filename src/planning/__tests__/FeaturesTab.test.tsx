import "@testing-library/jest-dom/vitest";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { open } from "./harness";
import { featureTeam } from "./fixtures";

afterEach(() => localStorage.clear());

describe("the features tab", () => {
  it("shows done vs pending, unestimated, others' stories, sprints left and risk; Removed left out", async () => {
    await open(featureTeam());
    fireEvent.click(screen.getByTestId("planning-tab-features"));
    expect(screen.queryByTestId("planning-feature-400")).toBeNull();
    const f = screen.getByTestId("planning-feature-100");
    expect(f).toHaveTextContent("2 sprints left");
    expect(screen.getByTestId("planning-feature-numbers-100")).toHaveTextContent("5 SP done · 21 SP pending (13 yours) · 1 not estimated");
    expect(screen.getByTestId("planning-feature-story-16")).toHaveTextContent("Erwin Alvarez");
    expect(screen.queryByTestId("planning-feature-story-17")).toBeNull();
    expect(screen.queryByTestId("planning-feature-risk-100")).toBeNull();
  });
});
