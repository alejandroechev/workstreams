import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { open } from "./harness";
import { featureTeam, planSprintTeam } from "./fixtures";

afterEach(() => localStorage.clear());

describe("planning a feature and publishing", () => {
  it("creates a feature with estimated stories, edits existing ones, and publishes only on request", async () => {
    const backend = await open(featureTeam());
    fireEvent.click(screen.getByTestId("planning-tab-plan-feature"));
    fireEvent.click(screen.getByTestId("planning-new-feature"));
    fireEvent.change(screen.getByTestId("planning-new-feature-title"), { target: { value: "Media_Store Write support" } });
    fireEvent.change(screen.getByTestId("planning-new-feature-target"), { target: { value: "2027-01-15" } });
    fireEvent.click(screen.getByTestId("planning-create-feature"));
    const addStory = async (title: string, points: string) => {
      fireEvent.change(await screen.findByTestId("planning-new-story-title"), { target: { value: title } });
      fireEvent.change(screen.getByTestId("planning-new-story-points"), { target: { value: points } });
      fireEvent.click(screen.getByTestId("planning-add-story"));
      await waitFor(() => expect((screen.getByTestId("planning-new-story-title") as HTMLInputElement).value).toBe(""));
    };
    await addStory("Write Frontend", "5");
    await addStory("FileSystem backend", "3");
    fireEvent.change(screen.getByTestId("planning-new-story-title"), { target: { value: "Half" } });
    fireEvent.change(screen.getByTestId("planning-new-story-points"), { target: { value: "2.5" } });
    expect(screen.getByTestId("planning-feature-total")).toHaveTextContent("10.5 SP");
    fireEvent.click(screen.getByTestId("planning-add-story"));
    await waitFor(() => expect(screen.getByTestId("planning-draft-count")).toHaveTextContent("4 changes not published"));

    // Another feature: re-estimate, reorder, remove.
    fireEvent.change(screen.getByTestId("planning-feature-select"), { target: { value: "300" } });
    fireEvent.change(await screen.findByTestId("planning-pf-points-31"), { target: { value: "2" } });
    fireEvent.blur(screen.getByTestId("planning-pf-points-31"));
    fireEvent.change(screen.getByTestId("planning-feature-select"), { target: { value: "100" } });
    fireEvent.click(await screen.findByTestId("planning-pf-down-11"));
    await waitFor(() => expect(screen.getAllByTestId(/^planning-pf-story-/)[0]).toHaveAttribute("data-testid", "planning-pf-story-12"));
    fireEvent.click(screen.getByTestId("planning-pf-remove-13"));
    await waitFor(() => expect(screen.queryByTestId("planning-pf-story-13")).toBeNull());
    fireEvent.click(screen.getByTestId("planning-draft-review"));
    expect(screen.getByTestId("planning-draft-list")).toHaveTextContent("New feature “Media_Store Write support”, target 2027-01-15");
    expect(backend.planningWrites()).toBe(0);

    await act(async () => { fireEvent.click(screen.getByTestId("planning-publish")); });
    await waitFor(() => expect(screen.getByTestId("planning-publish-result")).toHaveTextContent("published"));
    const ado = backend.planningAdoItems();
    const created = ado.find((i) => i.title === "Media_Store Write support")!;
    expect(created).toMatchObject({ kind: "Feature", target_date: "2027-01-15" });
    expect(ado.filter((i) => i.parent_id === created.id).map((i) => [i.title, i.story_points])).toEqual([
      ["Write Frontend", 5], ["FileSystem backend", 3], ["Half", 2.5],
    ]);
    expect(ado.find((i) => i.id === 31)?.story_points).toBe(2);
    expect(ado.find((i) => i.id === 13)?.state).toBe("Removed");
    expect(ado.find((i) => i.id === 11)?.order).toBe(2000);
    expect(screen.queryByTestId("planning-draft-count")).toBeNull();
  });

  it("holds back a story changed in ADO meanwhile, and Discard empties the draft", async () => {
    const backend = await open(planSprintTeam(), { sprint: "OneWork\\S23" });
    fireEvent.click(screen.getByTestId("planning-tab-plan-sprint"));
    for (const id of [42, 43, 44]) fireEvent.click(await screen.findByTestId(`planning-add-${id}`));
    await waitFor(() => expect(screen.getByTestId("planning-draft-count")).toHaveTextContent("3 changes not published"));
    backend.changePlanningItemInAdo(43, { iteration_path: "OneWork\\S24" });
    await act(async () => { fireEvent.click(screen.getByTestId("planning-publish")); });
    expect(await screen.findByTestId("planning-conflict-43")).toHaveTextContent("now OneWork\\S24");
    expect(screen.getByTestId("planning-draft-count")).toHaveTextContent("1 change not published");
    expect(backend.planningAdoItems().find((i) => i.id === 43)?.iteration_path).toBe("OneWork\\S24");
    fireEvent.click(screen.getByTestId("planning-discard"));
    await waitFor(() => expect(screen.queryByTestId("planning-draft-count")).toBeNull());
    expect((await backend.planningState()).draft).toEqual([]);
  });
});
