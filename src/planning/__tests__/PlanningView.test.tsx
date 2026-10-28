import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open } from "./harness";
import { planSprintTeam, sprintTeam, TEAM_LINK } from "./fixtures";

afterEach(() => localStorage.clear());

describe("connecting", () => {
  it("connects from a team link, and shows why a bad link is refused", async () => {
    const backend = await open(sprintTeam(), { connect: false });
    const input = await screen.findByTestId("planning-connect-input");
    fireEvent.change(input, { target: { value: "https://github.com/o/r" } });
    fireEvent.click(screen.getByTestId("planning-connect-submit"));
    expect(await screen.findByTestId("planning-connect-error")).toHaveTextContent("team sprint or backlog link");
    backend.setPlanningAuthError(true);
    fireEvent.change(input, { target: { value: TEAM_LINK } });
    fireEvent.click(screen.getByTestId("planning-connect-submit"));
    expect(await screen.findByTestId("planning-connect-error")).toHaveTextContent("az login");
    backend.setPlanningAuthError(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByTestId("planning-team")).toHaveTextContent("Waimea Bay");
  });

  it("locks the plan while publishing, so nothing changes under it", async () => {
    const backend = await open(planSprintTeam(), { sprint: "OneWork\\S23" });
    await backend.planningAddChange({ kind: "estimate", id: 43, rev: 1, points: 3 });
    fireEvent.click(screen.getByTestId("planning-refresh"));
    fireEvent.click(screen.getByTestId("planning-tab-plan-sprint"));
    let release!: () => void;
    const real = backend.planningPublish.bind(backend);
    vi.spyOn(backend, "planningPublish").mockImplementation(() => new Promise((resolve) => { release = () => resolve(real()); }));
    fireEvent.click(await screen.findByTestId("planning-publish"));
    await waitFor(() => expect(screen.getByTestId("planning-plan-area")).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByTestId("planning-add-42")).toBeDisabled();
    expect(screen.getByTestId("planning-discard")).toBeDisabled();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId("planning-plan-area")).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByTestId("planning-add-42")).not.toBeDisabled();
  });
});

