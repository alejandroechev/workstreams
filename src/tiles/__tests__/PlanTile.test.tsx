import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import PlanTile from "../PlanTile";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import type { AcceptanceTest, FeatureSummary, SessionFeaturesPayload } from "../../backend/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "# plan body") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../ui/MermaidDiagram", () => ({
  MermaidDiagram: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));
vi.mock("../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
const fileEditorMock = vi.hoisted(() => vi.fn());
vi.mock("../../files/FileEditorView", () => ({
  // Stub the real Monaco-backed editor: capture props + render the markdown
  // preview so the grill tab is exercisable in jsdom. Save UX (Ctrl+S/autosave)
  // is FileEditorView's own concern, covered by its tests.
  FileEditorView: (props: {
    path: string;
    renderMarkdownPreview?: (content: string) => React.ReactNode;
  }) => {
    fileEditorMock(props);
    return (
      <div data-testid="file-editor-view" data-path={props.path}>
        {props.renderMarkdownPreview?.("# grill preview")}
      </div>
    );
  },
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

function setup(
  payload: SessionFeaturesPayload,
  acceptance: Partial<AcceptanceTest>[] = [],
) {
  const backend = new MemoryBackend();
  backend.seedSessionFeatures("sess-1", payload);
  if (acceptance.length > 0) {
    backend.seedAcceptanceTests(
      acceptance.map((test, index) => ({
        id: test.id ?? `t-${index}`,
        plan_id: test.plan_id ?? "alpha-plan",
        at_id: test.at_id ?? `AT-${index + 1}`,
        title: test.title ?? `Test ${index + 1}`,
        validates: test.validates ?? null,
        automation: test.automation ?? "agent",
        status: test.status ?? "not_run",
        last_run_at: test.last_run_at ?? null,
        evidence: test.evidence ?? null,
        notes: test.notes ?? null,
      })),
    );
  }
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
    // Plan and Todos are gone: plans are read outside the app, and the todo
    // data still feeds Overview's progress bar without a tab of its own.
    // Acceptance is absent here because this feature has no tests.
    expect(tabIds).toEqual([
      "plan-tab-overview",
      "plan-tab-grill",
      "plan-tab-graph",
    ]);
  });

  it("opens grill-me.md in FileEditorView at its absolute path (unified save UX)", async () => {
    setup({ features: [feat("alpha")], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("plan-tab-grill")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-tab-grill"));
    // Renders through the shared FileEditorView (same Ctrl+S/autosave as any
    // regular file) pointed at the feature's absolute grill-me.md path — no
    // bespoke Edit/Save/Cancel buttons.
    await waitFor(() => expect(screen.getByTestId("file-editor-view")).toBeTruthy());
    expect(screen.getByTestId("file-editor-view").getAttribute("data-path")).toBe("/x/alpha/grill-me.md");
    expect(fileEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/x/alpha/grill-me.md" }),
    );
    // Legacy edit-mode affordances are gone.
    expect(screen.queryByTestId("grill-edit")).toBeNull();
    expect(screen.queryByTestId("grill-save")).toBeNull();
    expect(screen.queryByTestId("grill-editor")).toBeNull();
  });

  it("shows a placeholder when the feature has no grill-me.md", async () => {
    setup({
      features: [feat("alpha", { hasGrillMe: false, grillMePath: null })],
      currentPlanId: null,
    });
    await waitFor(() => expect(screen.getByTestId("plan-tab-grill")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-tab-grill"));
    await waitFor(() => expect(screen.getByText(/No grill-me\.md yet/)).toBeTruthy());
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
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

describe("PlanTile acceptance tab", () => {
  const withTests = (over: Partial<AcceptanceTest>[] = [{}]) =>
    setup({ features: [feat("alpha")], currentPlanId: null }, over);

  /** A feature planned before acceptance tests existed has none. */
  it("hides the tab when a feature has no acceptance tests", async () => {
    setup({ features: [feat("alpha")], currentPlanId: null });
    await waitFor(() => expect(screen.getByTestId("plan-tab-overview")).toBeTruthy());
    expect(screen.queryByTestId("plan-tab-acceptance")).toBeNull();
  });

  it("shows the tab, and the tests, when a feature has them", async () => {
    withTests([
      { at_id: "AT-1", title: "Lane colours are distinct", automation: "human-only" },
      { at_id: "AT-2", title: "Drag files a workstream", status: "pass" },
    ]);
    await waitFor(() => expect(screen.getByTestId("plan-tab-acceptance")).toBeTruthy());

    fireEvent.click(screen.getByTestId("plan-tab-acceptance"));
    expect(screen.getByText("Lane colours are distinct")).toBeTruthy();
    // How a test is run is the thing you need before deciding to run it.
    expect(screen.getByTestId("acceptance-automation-AT-1").textContent).toBe("human-only");
    expect(screen.getByTestId("acceptance-summary").textContent).toContain("1 pass");
  });

  it("sorts AT-10 after AT-9 rather than after AT-1", async () => {
    withTests([{ at_id: "AT-10" }, { at_id: "AT-9" }, { at_id: "AT-2" }]);
    await waitFor(() => expect(screen.getByTestId("plan-tab-acceptance")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-tab-acceptance"));

    const ids = Array.from(document.querySelectorAll('[data-testid^="acceptance-test-"]')).map(
      (node) => node.getAttribute("data-testid"),
    );
    expect(ids).toEqual([
      "acceptance-test-AT-2",
      "acceptance-test-AT-9",
      "acceptance-test-AT-10",
    ]);
  });

  it("records a status the user sets", async () => {
    const backend = withTests([{ id: "t-a", at_id: "AT-1" }]);
    await waitFor(() => expect(screen.getByTestId("plan-tab-acceptance")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-tab-acceptance"));

    fireEvent.click(screen.getByTestId("acceptance-set-AT-1-pass"));
    await waitFor(async () => {
      const [test] = await backend.listSessionAcceptanceTests("sess-1", "alpha-plan");
      expect(test.status).toBe("pass");
      expect(test.last_run_at).not.toBeNull();
    });
  });

  /** `not_run` means never run, so a leftover timestamp would contradict it. */
  it("clears the run time when a test is set back to not run", async () => {
    const backend = withTests([
      { id: "t-a", at_id: "AT-1", status: "pass", last_run_at: "2026-09-14T10:00:00Z" },
    ]);
    await waitFor(() => expect(screen.getByTestId("plan-tab-acceptance")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-tab-acceptance"));

    fireEvent.click(screen.getByTestId("acceptance-set-AT-1-not_run"));
    await waitFor(async () => {
      const [test] = await backend.listSessionAcceptanceTests("sess-1", "alpha-plan");
      expect(test.status).toBe("not_run");
      expect(test.last_run_at).toBeNull();
    });
  });
});
