import "@testing-library/jest-dom/vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { open } from "./harness";
import { taskTeam } from "./fixtures";

afterEach(() => localStorage.clear());

const rows = (story: number) => within(screen.getByTestId(`planning-story-${story}`)).queryAllByTestId(/^planning-task-\d+$/);
const ids = (story: number) => rows(story).map((r) => Number(r.dataset.testid!.split("-").pop()));
const pick = (task: number, state: string) => fireEvent.change(screen.getByTestId(`planning-task-state-${task}`), { target: { value: state } });

describe("tasks in the sprint tab", () => {
  it("lists each story's tasks by state with others' assignee, in both layouts; no Removed task or Bug", async () => {
    await open(taskTeam());
    expect(ids(3)).toEqual([33, 32, 34, 31]);
    const row = screen.getByTestId("planning-task-33");
    expect(row).toHaveTextContent("Write tests");
    expect(row).toHaveTextContent("Erwin Alvarez");
    expect(screen.getByTestId("planning-task-32")).not.toHaveTextContent("Me");
    expect(within(row).getByRole("link", { name: "Write tests" })).toHaveAttribute("href", "https://dev.azure.com/skype/OneWork/_workitems/edit/33");
    expect((screen.getByTestId("planning-task-state-32") as HTMLSelectElement).value).toBe("Active");
    expect(screen.queryByText("Old idea")).toBeNull();
    expect(screen.queryByText("A bug")).toBeNull();
    expect(rows(2)).toEqual([]);
    fireEvent.click(screen.getByTestId("planning-layout-feature"));
    expect(ids(3)).toEqual([33, 32, 34, 31]);
  });

  it("hides tasks with a remembered switch, and expands a card on its own", async () => {
    await open(taskTeam());
    const toggle = screen.getByTestId("planning-show-tasks");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(rows(3)).toEqual([]);
    cleanup();
    await open(taskTeam());
    expect(screen.getByTestId("planning-show-tasks")).toHaveAttribute("aria-pressed", "false");
    expect(rows(3)).toEqual([]);
    fireEvent.click(screen.getByTestId("planning-tasks-3"));
    expect(ids(3)).toEqual([33, 32, 34, 31]);
    expect(rows(7)).toEqual([]);
  });

  it("puts a state change in the draft, shows it pending, and drops it when set back", async () => {
    const backend = await open(taskTeam());
    const options = [...(screen.getByTestId("planning-task-state-32") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["New", "Active", "Blocked", "Resolved", "Closed"]);
    const header = screen.getByTestId("planning-sprint-header").textContent;
    expect(screen.getByTestId("planning-tasks-3")).toHaveTextContent("2/4 tasks");
    pick(32, "Closed");
    await screen.findByTestId("planning-task-pending-32");
    expect((screen.getByTestId("planning-task-state-32") as HTMLSelectElement).value).toBe("Closed");
    expect(screen.getByTestId("planning-tasks-3")).toHaveTextContent("3/4 tasks");
    expect(within(screen.getByTestId("planning-column-Active")).getByTestId("planning-story-3")).toBeInTheDocument();
    expect(screen.getByTestId("planning-sprint-header").textContent).toBe(header);
    expect(screen.getByTestId("planning-draft-count")).toHaveTextContent("1 change not published");
    expect((await backend.planningState()).draft).toEqual([{ kind: "set_state", id: 32, rev: 1, state: "Closed" }]);
    expect(backend.planningWrites()).toBe(0);
    pick(32, "Active");
    await waitFor(() => expect(screen.queryByTestId("planning-task-pending-32")).toBeNull());
    expect(screen.getByTestId("planning-tasks-3")).toHaveTextContent("2/4 tasks");
    expect((await backend.planningState()).draft).toEqual([]);
  });

  it("offers to resolve a story once its tasks are done; dismissing waits for a task change", async () => {
    const backend = await open(taskTeam());
    expect(screen.queryByTestId(/^planning-resolve-offer-/)).toBeNull();
    pick(32, "Closed");
    await screen.findByTestId("planning-task-pending-32");
    pick(33, "Resolved");
    await screen.findByTestId("planning-resolve-offer-3");
    expect(screen.queryByTestId("planning-resolve-offer-7")).toBeNull();
    expect(screen.queryByTestId("planning-resolve-offer-2")).toBeNull();
    fireEvent.click(screen.getByTestId("planning-resolve-dismiss-3"));
    expect(screen.queryByTestId("planning-resolve-offer-3")).toBeNull();
    pick(33, "Closed");
    await screen.findByTestId("planning-resolve-offer-3");
    fireEvent.click(screen.getByTestId("planning-resolve-3"));
    await screen.findByTestId("planning-resolve-pending-3");
    expect(screen.queryByTestId("planning-resolve-offer-3")).toBeNull();
    expect(within(screen.getByTestId("planning-column-Active")).getByTestId("planning-story-3")).toBeInTheDocument();
    expect((await backend.planningState()).draft).toContainEqual({ kind: "set_state", id: 3, rev: 1, state: "Resolved" });
    expect(screen.getByTestId("planning-draft-count")).toHaveTextContent("3 changes not published");
  });

  it("brings a dismissed offer back after any task change, and never offers it for a story being removed", async () => {
    const backend = await open(taskTeam());
    pick(32, "Closed");
    await screen.findByTestId("planning-task-pending-32");
    pick(33, "Closed");
    await screen.findByTestId("planning-resolve-offer-3");
    fireEvent.click(screen.getByTestId("planning-resolve-dismiss-3"));
    pick(33, "Active");
    await waitFor(() => expect((screen.getByTestId("planning-task-state-33") as HTMLSelectElement).value).toBe("Active"));
    pick(33, "Closed");
    await screen.findByTestId("planning-resolve-offer-3");

    await backend.planningAddChange({ kind: "remove", id: 3, rev: 1 });
    fireEvent.click(screen.getByTestId("planning-refresh"));
    await waitFor(() => expect(screen.queryByTestId("planning-resolve-offer-3")).toBeNull());
  });
});
