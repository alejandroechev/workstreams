import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "./harness";
import { orphanPrs, taskTeam } from "./fixtures";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-30T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

const rows = () => screen.queryAllByTestId(/^planning-orphan-row-/).map((r) => Number(r.dataset.testid!.split("-").pop()));
const tab = () => screen.getByTestId("planning-tab-orphans");

async function openTab(prs = orphanPrs()) {
  const backend = await open(taskTeam(), { prs });
  fireEvent.click(tab());
  await screen.findByTestId("planning-orphans");
  return backend;
}

describe("the Orphaned PRs tab", () => {
  it("lists my unlinked, non-abandoned PRs from every repo, newest first, with the count on the tab", async () => {
    await openTab();
    await waitFor(() => expect(rows()).toEqual([103, 101, 102, 104]));
    expect(tab()).toHaveTextContent("Orphaned PRs · 4");
    const row = screen.getByTestId("planning-orphan-row-102");
    expect(row).toHaveTextContent("SCC/acs_media_sdk");
    expect(row).toHaveTextContent("draft");
    expect(row).toHaveTextContent("2026-10-27");
    expect(within(row).getByRole("link", { name: "Draft: async SDK design" })).toHaveAttribute("href", "https://dev.azure.com/skype/SCC/_git/acs_media_sdk/pullrequest/102");
    expect(screen.getByTestId("planning-orphan-row-104")).toHaveTextContent("OneWork/other-repo");
  });

  it("changes and remembers the range", async () => {
    const backend = await openTab();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const picker = screen.getByTestId("planning-orphan-days") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["7", "30", "90"]);
    expect(picker.value).toBe("30");
    fireEvent.change(picker, { target: { value: "90" } });
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect((await backend.planningOrphans()).days).toBe(90);
    fireEvent.change(picker, { target: { value: "7" } });
    await waitFor(() => expect(rows()).toEqual([103, 101, 102]));
  });

  it("hides a PR or a whole repo, lists them under Show hidden, and unhides", async () => {
    await openTab();
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.click(screen.getByTestId("planning-orphan-hide-104"));
    await waitFor(() => expect(rows()).toEqual([103, 101, 102]));
    fireEvent.click(screen.getByTestId("planning-orphan-hide-repo-101"));
    await waitFor(() => expect(rows()).toEqual([103]));
    expect(tab()).toHaveTextContent("Orphaned PRs · 1");
    fireEvent.click(screen.getByTestId("planning-orphan-show-hidden"));
    expect(screen.getByTestId("planning-orphan-show-hidden")).toHaveTextContent("Show hidden (2)");
    expect(screen.getByTestId("planning-orphan-hidden-list")).toHaveTextContent("Other project change");
    expect(screen.getByTestId("planning-orphan-hidden-list")).toHaveTextContent("SCC/acs_media_sdk");
    fireEvent.click(screen.getByTestId("planning-orphan-unhide-repo-acs_media_sdk-id"));
    await waitFor(() => expect(rows()).toEqual([103, 101, 102]));
  });

  it("links a PR to a sprint story's task or a feature story through the draft", async () => {
    const backend = await openTab();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const picker = screen.getByTestId("planning-orphan-link-103") as HTMLSelectElement;
    const labels = [...picker.options].map((o) => o.textContent);
    expect(labels).toContain("AMS Application State");
    expect(labels).toContain("— Implement handler");
    expect(labels).toContain("No tasks yet");
    fireEvent.change(picker, { target: { value: "32" } });
    await screen.findByTestId("planning-orphan-pending-103");
    expect(screen.getByTestId("planning-orphan-pending-103")).toHaveTextContent("Implement handler");
    expect(screen.getByTestId("planning-draft-count")).toHaveTextContent("1 change not published");
    expect(backend.planningWrites()).toBe(0);
    fireEvent.change(screen.getByTestId("planning-orphan-link-101"), { target: { value: "2" } });
    await screen.findByTestId("planning-orphan-pending-101");
    await act(async () => { fireEvent.click(screen.getByTestId("planning-publish")); });
    await waitFor(() => expect(screen.getByTestId("planning-publish-result")).toHaveTextContent("2 published"));
    expect(backend.planningPrLinks(103)).toEqual([32]);
    await waitFor(() => expect(rows()).toEqual([102, 104]));
  });

  it("unlinks a pending link by choosing none", async () => {
    const backend = await openTab();
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.change(screen.getByTestId("planning-orphan-link-103"), { target: { value: "2" } });
    await screen.findByTestId("planning-orphan-pending-103");
    fireEvent.change(screen.getByTestId("planning-orphan-link-103"), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByTestId("planning-orphan-pending-103")).toBeNull());
    expect((await backend.planningState()).draft).toEqual([]);
    cleanup();
  });
});
