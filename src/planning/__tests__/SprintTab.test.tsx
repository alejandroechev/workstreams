import "@testing-library/jest-dom/vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { open } from "./harness";
import { sprintTeam } from "./fixtures";

afterEach(() => localStorage.clear());

describe("the sprint tab", () => {
  it("shows only my stories, by state, with SP, feature, tasks and the header", async () => {
    await open(sprintTeam());
    expect(screen.getByTestId("planning-sprint-header")).toHaveTextContent("7 / 8 SP committed · 1 done · 6 to go · 10 days left · 1 not estimated");
    expect(within(screen.getByTestId("planning-column-New")).getAllByTestId(/^planning-story-/).map((e) => e.dataset.testid))
      .toEqual(["planning-story-2", "planning-story-4"]);
    expect(within(screen.getByTestId("planning-column-Active")).getByTestId("planning-story-3")).toBeInTheDocument();
    expect(within(screen.getByTestId("planning-column-Closed")).getByTestId("planning-story-1")).toBeInTheDocument();
    expect(screen.queryByTestId("planning-story-5")).toBeNull();
    expect(screen.queryByTestId("planning-story-6")).toBeNull();
    expect(screen.getByTestId("planning-tasks-2")).toHaveTextContent("0/3 tasks");
    expect(screen.getByTestId("planning-tasks-3")).toHaveTextContent("2/4 tasks");
    expect(screen.getByTestId("planning-sp-4")).toHaveTextContent("?");
    fireEvent.click(screen.getByTestId("planning-layout-feature"));
    expect(screen.getAllByTestId("planning-feature-group")[0]).toHaveTextContent("Audio Transcoding");
    expect(localStorage.getItem("planning.layout")).toBe("feature");
  });

  it("offers the current sprint once the selected one has ended, and follows the picker", async () => {
    const backend = await open(sprintTeam(), { sprint: "OneWork\\S21" });
    expect(screen.getByTestId("planning-ended-banner")).toHaveTextContent("S21 (Oct 25) has finished");
    fireEvent.click(screen.getByTestId("planning-switch-current"));
    await waitFor(() => expect(screen.queryByTestId("planning-ended-banner")).toBeNull());
    fireEvent.change(screen.getByTestId("planning-sprint-select"), { target: { value: "OneWork\\S23" } });
    await waitFor(() => expect((screen.getByTestId("planning-sprint-select") as HTMLSelectElement).value).toBe("OneWork\\S23"));
    expect((await backend.planningState()).selected_sprint).toBe("OneWork\\S23");
  });
});
