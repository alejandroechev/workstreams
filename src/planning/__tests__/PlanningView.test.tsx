import "@testing-library/jest-dom/vitest";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { open } from "./harness";
import { sprintTeam, TEAM_LINK } from "./fixtures";

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
});
