import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "./harness";
import { KTLO_LINK, ktloTeam, orphanPrs, taskTeam } from "./fixtures";

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

describe("KTLO stories on the Orphaned PRs tab", () => {
  async function openKtlo(options: { set?: boolean; sprint?: string } = {}) {
    const backend = await open(ktloTeam(), { prs: orphanPrs(), sprint: options.sprint });
    fireEvent.click(tab());
    await waitFor(() => expect(rows()).toHaveLength(4));
    if (options.set !== false) {
      await backend.planningSetKtlo(KTLO_LINK);
      fireEvent.click(screen.getByTestId("planning-refresh"));
      await waitFor(() => expect(screen.getByTestId("planning-ktlo")).toHaveTextContent("KTLO — H2 2026"));
    }
    return backend;
  }
  const linkSelect = (pr: number) => screen.getByTestId(`planning-orphan-link-${pr}`) as HTMLSelectElement;
  const newOption = (pr: number) => [...linkSelect(pr).options].find((o) => o.value === "new-ktlo")!;

  it("sets the KTLO feature from its link, and refuses one that isn't an open feature", async () => {
    await openKtlo({ set: false });
    expect(screen.getByTestId("planning-ktlo")).toHaveTextContent("Set the KTLO feature");
    expect(newOption(101)).toBeDisabled();
    fireEvent.change(screen.getByTestId("planning-ktlo-input"), { target: { value: KTLO_LINK.replace("4533022", "7001") } });
    fireEvent.click(screen.getByTestId("planning-ktlo-set"));
    expect(await screen.findByTestId("planning-ktlo-error")).toHaveTextContent("not a Feature");
    fireEvent.change(screen.getByTestId("planning-ktlo-input"), { target: { value: KTLO_LINK } });
    fireEvent.click(screen.getByTestId("planning-ktlo-set"));
    await waitFor(() => expect(screen.getByTestId("planning-ktlo")).toHaveTextContent("KTLO — H2 2026"));
    expect(screen.getByTestId("planning-ktlo")).toHaveTextContent("#4533022");
    expect(newOption(101)).not.toBeDisabled();
  });

  it("disables new KTLO stories while the feature is closed", async () => {
    const backend = await openKtlo();
    backend.changePlanningItemInAdo(4533022, { state: "Closed" });
    fireEvent.click(screen.getByTestId("planning-refresh"));
    await waitFor(() => expect(screen.getByTestId("planning-ktlo-problem")).toHaveTextContent("Closed"));
    expect(newOption(101)).toBeDisabled();
  });

  it("drafts a story under the KTLO feature with the PR's title, 1 point and the next sprint", async () => {
    const backend = await openKtlo({ sprint: "OneWork\\S21" });
    fireEvent.change(linkSelect(101), { target: { value: "new-ktlo" } });
    const form = await screen.findByTestId("planning-ktlo-form-101");
    expect(within(form).getByTestId("planning-ktlo-name")).toHaveValue("Fix chunk reader retries");
    expect(within(form).getByTestId("planning-ktlo-points")).toHaveValue(1);
    const sprint = within(form).getByTestId("planning-ktlo-sprint") as HTMLSelectElement;
    expect(sprint.value).toBe("OneWork\\S23");
    expect([...sprint.options].map((o) => o.value)).toEqual(["OneWork\\S22", "OneWork\\S23", "OneWork\\S24"]);
    fireEvent.click(within(form).getByTestId("planning-ktlo-add"));
    await waitFor(() => expect(screen.getByTestId("planning-orphan-pending-101")).toHaveTextContent("New KTLO story “Fix chunk reader retries” (1 pt, S23 (Nov 22)), not published"));
    expect(screen.queryByTestId("planning-ktlo-form-101")).toBeNull();
    const draft = (await backend.planningState()).draft;
    expect(draft).toEqual([
      { kind: "create_story", temp_id: -1, parent: 4533022, title: "Fix chunk reader retries", points: 1, description: null, iteration: "OneWork\\S23", order: null },
      { kind: "link_pr", id: -1, rev: 0, pr: { id: 101, project_id: "SCC-id", repo_id: "acs_media_sdk-id", title: "Fix chunk reader retries" } },
    ]);
    expect(backend.planningWrites()).toBe(0);
  });

  it("offers a drafted story to other PRs, and unlinking the PR it was made for drops it", async () => {
    const backend = await openKtlo();
    fireEvent.change(linkSelect(101), { target: { value: "new-ktlo" } });
    fireEvent.change(await screen.findByTestId("planning-ktlo-name"), { target: { value: "Dependency bumps" } });
    fireEvent.click(screen.getByTestId("planning-ktlo-add"));
    await screen.findByTestId("planning-orphan-pending-101");
    const offered = [...linkSelect(103).options].find((o) => o.value === "-1")!;
    expect(offered).toHaveTextContent("New: Dependency bumps (not published)");
    fireEvent.change(linkSelect(103), { target: { value: "-1" } });
    await waitFor(() => expect(screen.getByTestId("planning-orphan-pending-103")).toHaveTextContent("Dependency bumps"));
    fireEvent.change(linkSelect(101), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByTestId("planning-orphan-pending-103")).toBeNull());
    expect(screen.queryByTestId("planning-orphan-pending-101")).toBeNull();
    expect((await backend.planningState()).draft).toEqual([]);
  });

  it("choosing a PR's own drafted story again changes nothing", async () => {
    const backend = await openKtlo();
    fireEvent.change(linkSelect(101), { target: { value: "new-ktlo" } });
    fireEvent.click(await screen.findByTestId("planning-ktlo-add"));
    await screen.findByTestId("planning-orphan-pending-101");
    const before = (await backend.planningState()).draft;
    fireEvent.change(linkSelect(101), { target: { value: "new-ktlo" } });
    await screen.findByTestId("planning-ktlo-form-101");
    fireEvent.change(linkSelect(101), { target: { value: "-1" } });
    await waitFor(() => expect(screen.queryByTestId("planning-ktlo-form-101")).toBeNull());
    expect((await backend.planningState()).draft).toEqual(before);
  });

  it("cancelling the form changes nothing", async () => {
    const backend = await openKtlo();
    fireEvent.change(linkSelect(101), { target: { value: "new-ktlo" } });
    fireEvent.click(await screen.findByTestId("planning-ktlo-cancel"));
    expect(screen.queryByTestId("planning-ktlo-form-101")).toBeNull();
    expect(linkSelect(101).value).toBe("");
    expect((await backend.planningState()).draft).toEqual([]);
  });
});
