import "@testing-library/jest-dom/vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { open } from "./harness";
import { planSprintTeam } from "./fixtures";

afterEach(() => localStorage.clear());

describe("planning a sprint", () => {
  it("lists candidates, follows the gauge as stories move, and never blocks", async () => {
    const backend = await open(planSprintTeam(), { sprint: "OneWork\\S23" });
    fireEvent.click(screen.getByTestId("planning-tab-plan-sprint"));
    const groups = screen.getAllByTestId(/^planning-candidate-group-/);
    expect(groups[0]).toHaveAttribute("data-carry", "true");
    expect(within(groups[0]).getByTestId("planning-candidate-42")).toBeInTheDocument();
    const gauge = () => [screen.getByTestId("planning-gauge").dataset.state, screen.getByTestId("planning-gauge-total").textContent, screen.getByTestId("planning-gauge-text").textContent];
    expect(gauge()).toEqual(["under", "3 / 8 SP", "5 to go"]);
    fireEvent.click(screen.getByTestId("planning-add-42"));
    fireEvent.click(await screen.findByTestId("planning-add-43"));
    await waitFor(() => expect(gauge()).toEqual(["on", "8 / 8 SP", "On target"]));
    fireEvent.click(screen.getByTestId("planning-add-45"));
    fireEvent.click(await screen.findByTestId("planning-add-44"));
    await waitFor(() => expect(gauge()).toEqual(["over", "13 / 8 SP", "5 over the goal · 1 not estimated"]));
    expect(screen.getByTestId("planning-draft-count")).toHaveTextContent("4 changes not published");
    expect(backend.planningWrites()).toBe(0);
    // Taking one back out undoes its draft change; taking out one that was there moves it to its feature.
    fireEvent.click(screen.getByTestId("planning-take-out-44"));
    fireEvent.click(await screen.findByTestId("planning-take-out-41"));
    await waitFor(() => expect(screen.getByTestId("planning-draft-count")).toHaveTextContent("4 changes not published"));
    expect((await backend.planningState()).draft).toContainEqual({ kind: "move", id: 41, rev: 1, to_iteration: "OneWork\\Q4", assign_to_me: false });
    expect((await backend.planningState()).draft).toContainEqual({ kind: "move", id: 45, rev: 1, to_iteration: "OneWork\\S23", assign_to_me: true });
  });

  it("plans a story that only exists in the draft into the sprint and back out", async () => {
    const backend = await open(planSprintTeam(), { sprint: "OneWork\\S23" });
    await backend.planningAddChange({ kind: "create_story", temp_id: -1, parent: 100, title: "Brand new", points: 2, description: null });
    fireEvent.click(screen.getByTestId("planning-refresh"));
    fireEvent.click(screen.getByTestId("planning-tab-plan-sprint"));
    fireEvent.click(await screen.findByTestId("planning-add--1"));
    await screen.findByTestId("planning-planned--1");
    expect((await backend.planningState()).draft).toEqual([expect.objectContaining({ kind: "create_story", temp_id: -1, iteration: "OneWork\\S23" })]);
    fireEvent.click(screen.getByTestId("planning-take-out--1"));
    await screen.findByTestId("planning-candidate--1");
    expect((await backend.planningState()).draft).toEqual([expect.objectContaining({ kind: "create_story", temp_id: -1, iteration: "OneWork\\Q4" })]);
  });
});
