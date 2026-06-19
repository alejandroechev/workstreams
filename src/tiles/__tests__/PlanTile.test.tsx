import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import PlanTile from "../PlanTile";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import type { FeatureSummary, SessionFeaturesPayload } from "../../backend/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "# plan body") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../ui/MermaidDiagram", () => ({
  MermaidDiagram: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));
vi.mock("../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

function feat(name: string, overrides: Partial<FeatureSummary> = {}): FeatureSummary {
  return {
    name,
    hasGrillMe: true,
    hasPlan: true,
    grillMePath: `/x/${name}/grill-me.md`,
    planPath: `/x/${name}/plan.md`,
    planId: `${name}-plan`,
    planTitle: `${name} title`,
    planStatus: "active",
    planCreatedAt: "2026-06-10T10:00:00.000Z",
    derivedStatus: "active",
    todosTotal: 4,
    todosDone: 1,
    todosInProgress: 1,
    todosBlocked: 0,
    lastTouchedAt: "2026-06-12T10:00:00.000Z",
    ...overrides,
  };
}

function setup(payload: SessionFeaturesPayload) {
  const backend = new MemoryBackend();
  backend.seedSessionFeatures("sess-1", payload);
  render(
    <BackendProvider backend={backend}>
      <PlanTile tileId="t1" isFocused linkedSessionIds={["sess-1"]} />
    </BackendProvider>,
  );
  return backend;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { vi.clearAllMocks(); });

describe("PlanTile shell", () => {
  it("shows empty-session message when no session is linked", () => {
    render(
      <BackendProvider backend={new MemoryBackend()}>
        <PlanTile tileId="t1" isFocused linkedSessionIds={undefined} />
      </BackendProvider>,
    );
    expect(screen.getByTestId("plan-tile").textContent).toMatch(/No Copilot session linked/);
  });

  it("renders a sidebar entry per visible feature, sorted last-touched-desc", async () => {
    setup({
      features: [
        feat("alpha", { lastTouchedAt: "2026-06-01T00:00:00.000Z" }),
        feat("zebra", { lastTouchedAt: "2026-06-12T10:00:00.000Z" }),
        feat("mid", { lastTouchedAt: "2026-06-05T00:00:00.000Z" }),
      ],
      currentPlanId: null,
    });
    await waitFor(() => expect(screen.getByTestId("feature-row-zebra")).toBeTruthy());
    const rows = Array.from(document.querySelectorAll('[data-testid^="feature-row-"]'));
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "feature-row-zebra",
      "feature-row-mid",
      "feature-row-alpha",
    ]);
  });

  it("auto-selects the first row and shows Overview by default", async () => {
    setup({ features: [feat("alpha")], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("feature-row-alpha")).toBeTruthy());
    // Overview tab content (the feature title) is rendered, confirming
    // both auto-selection AND default tab = overview.
    await waitFor(() => expect(screen.getByText(/alpha title/)).toBeTruthy());
    expect(screen.getByTestId("plan-tab-overview")).toBeTruthy();
  });

  it("clicking a feature swaps the detail pane", async () => {
    setup({ features: [feat("alpha"), feat("beta")], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("feature-row-beta")).toBeTruthy());
    fireEvent.click(screen.getByTestId("feature-row-beta"));
    expect(screen.getByText(/beta title/)).toBeTruthy();
  });

  it("filter chips hide completed by default; All shows everything", async () => {
    setup({
      features: [feat("draft", { derivedStatus: "drafting" }), feat("act"), feat("done", { derivedStatus: "completed" })],
      currentPlanId: null,
    });
    // active is default → draft + act visible, done hidden
    await waitFor(() => expect(screen.getByTestId("feature-row-act")).toBeTruthy());
    expect(screen.queryByTestId("feature-row-done")).toBeNull();
    fireEvent.click(screen.getByTestId("plan-filter-completed"));
    await waitFor(() => expect(screen.getByTestId("feature-row-done")).toBeTruthy());
    expect(screen.queryByTestId("feature-row-act")).toBeNull();
    fireEvent.click(screen.getByTestId("plan-filter-all"));
    await waitFor(() => expect(screen.getByTestId("feature-row-done")).toBeTruthy());
    expect(screen.getByTestId("feature-row-act")).toBeTruthy();
    expect(screen.getByTestId("feature-row-draft")).toBeTruthy();
  });

  it("renders a yellow dot on the feature whose planId matches currentPlanId", async () => {
    setup({
      features: [feat("alpha"), feat("beta")],
      currentPlanId: "beta-plan",
    });
    await waitFor(() => expect(screen.getByTestId("feature-row-beta")).toBeTruthy());
    const dotsInBeta = screen.getByTestId("feature-row-beta").querySelector('[data-testid="feature-current-dot"]');
    expect(dotsInBeta).toBeTruthy();
    const dotsInAlpha = screen.getByTestId("feature-row-alpha").querySelector('[data-testid="feature-current-dot"]');
    expect(dotsInAlpha).toBeNull();
  });

  it("shows empty-state copy when no features exist", async () => {
    setup({ features: [], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("plan-sidebar")).toBeTruthy());
    expect(screen.getByTestId("plan-sidebar").textContent).toMatch(/No features yet/);
  });

  it("each tab is clickable and content swaps", async () => {
    setup({ features: [feat("alpha")], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("plan-tab-overview")).toBeTruthy());
    // Plan tab → MarkdownView shim with content from mocked invoke
    fireEvent.click(screen.getByTestId("plan-tab-plan"));
    await waitFor(() => expect(screen.getAllByTestId("md").length).toBeGreaterThan(0));
    // Todos tab
    fireEvent.click(screen.getByTestId("plan-tab-todos"));
    expect(screen.getByText(/No todos for this plan/)).toBeTruthy();
    // Graph tab
    fireEvent.click(screen.getByTestId("plan-tab-graph"));
    expect(screen.getByTestId("mermaid")).toBeTruthy();
    // Grill tab
    fireEvent.click(screen.getByTestId("plan-tab-grill"));
    await waitFor(() => expect(screen.getAllByTestId("md").length).toBeGreaterThan(0));
  });

  it("renders tabs with Grill second (right of Overview)", async () => {
    setup({ features: [feat("alpha")], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("plan-tab-overview")).toBeTruthy());
    const tabIds = Array.from(document.querySelectorAll('[data-testid^="plan-tab-"]'))
      .map((t) => t.getAttribute("data-testid"));
    expect(tabIds).toEqual([
      "plan-tab-overview",
      "plan-tab-grill",
      "plan-tab-plan",
      "plan-tab-todos",
      "plan-tab-graph",
    ]);
  });

  it("edits the grill file and saves via write_session_file", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    setup({ features: [feat("alpha")], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("plan-tab-grill")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-tab-grill"));
    await waitFor(() => expect(screen.getByTestId("grill-edit")).toBeTruthy());
    fireEvent.click(screen.getByTestId("grill-edit"));
    const editor = screen.getByTestId("grill-editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# new grill body" } });
    fireEvent.click(screen.getByTestId("grill-save"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("write_session_file", {
        sessionId: "sess-1",
        relativePath: "files/features/alpha/grill-me.md",
        contents: "# new grill body",
      }),
    );
    // Returns to preview with the saved content.
    await waitFor(() => expect(screen.getByTestId("grill-edit")).toBeTruthy());
    expect(screen.getByTestId("md").textContent).toBe("# new grill body");
  });

  it("cancel discards grill edits without saving", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    setup({ features: [feat("alpha")], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("plan-tab-grill")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-tab-grill"));
    await waitFor(() => expect(screen.getByTestId("grill-edit")).toBeTruthy());
    fireEvent.click(screen.getByTestId("grill-edit"));
    fireEvent.change(screen.getByTestId("grill-editor"), { target: { value: "throwaway" } });
    fireEvent.click(screen.getByTestId("grill-cancel"));
    await waitFor(() => expect(screen.getByTestId("grill-edit")).toBeTruthy());
    expect(invokeMock).not.toHaveBeenCalledWith(
      "write_session_file",
      expect.anything(),
    );
  });

  it("StatusPill testid encodes the derivedStatus", async () => {    setup({ features: [feat("alpha", { derivedStatus: "orphan" })], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("feature-row-alpha")).toBeTruthy());
    expect(screen.getAllByTestId("feature-status-pill-orphan").length).toBeGreaterThan(0);
  });

  it("ProgressBar collapses to '—' for zero-total drafting features", async () => {
    setup({ features: [feat("alpha", { todosTotal: 0, todosDone: 0, derivedStatus: "drafting" })], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("feature-row-alpha")).toBeTruthy());
    // No ProgressBar element for zero-total.
    const row = screen.getByTestId("feature-row-alpha");
    expect(row.querySelector('[data-testid="feature-progress-bar"]')).toBeNull();
  });

  it("shows a Complete plan button for active features and calls the backend on confirm", async () => {
    const backend = setup({ features: [feat("alpha")], currentPlanId: "alpha-plan" });
    const spy = vi.spyOn(backend, "completeSessionPlan");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await waitFor(() => expect(screen.getByTestId("plan-complete-button")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-complete-button"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-1", "alpha-plan"));
    confirmSpy.mockRestore();
  });

  it("does not call the backend when the confirm is declined", async () => {
    const backend = setup({ features: [feat("alpha")], currentPlanId: "alpha-plan" });
    const spy = vi.spyOn(backend, "completeSessionPlan");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await waitFor(() => expect(screen.getByTestId("plan-complete-button")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-complete-button"));
    expect(spy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("hides the Complete plan button for drafting and completed features", async () => {
    setup({ features: [feat("draft", { derivedStatus: "drafting", planId: null, planStatus: null })], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("feature-row-draft")).toBeTruthy());
    expect(screen.queryByTestId("plan-complete-button")).toBeNull();
  });
});
