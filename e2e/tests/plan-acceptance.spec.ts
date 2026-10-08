/**
 * E2E for the Plan tile's Acceptance tab.
 *
 * Seeds features and acceptance tests through `window.__WS_BACKEND__`, the
 * existing E2E seam on `MemoryBackend`, so each spec brings its own fixture
 * rather than sharing one baked into `main.tsx`.
 */
import { test, expect, type Page } from "@playwright/test";

type SeedBackend = {
  seedSessionFeatures: (sessionId: string, payload: unknown) => void;
  seedAcceptanceTests: (tests: unknown[]) => void;
  listWorkstreams: () => Promise<Array<{ id: string }>>;
  listTiles: (workstreamId: string) => Promise<Array<{ id: string; tile_type: string; config_json: string }>>;
  updateTileConfig: (id: string, configJson: string) => Promise<void>;
};

async function configure(page: Page) {
  await page.addInitScript(() => {
    // A workstream whose session tile is already linked: the Plan tile reads
    // its session id from that config, so an unlinked workstream renders
    // nothing to assert on.
    (window as unknown as { __WS_DEMO_SEED__?: unknown }).__WS_DEMO_SEED__ = {
      projects: [{ name: "Demo", directory: "C:\\repos\\demo" }],
      workstreams: [
        {
          name: "Plan demo",
          directory: "C:\\repos\\demo",
          project: "Demo",
          tiles: [
            {
              type: "copilot_session",
              title: "Plan demo",
              config: { pinned: true, copilot_session_id: "e2e-session" },
            },
          ],
        },
      ],
    };
    const handlers: Record<string, () => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      spawn_terminal: () => null,
      spawn_copilot_session: () => null,
      read_session_file: () => "# plan\n",
      list_session_features: () => ({ features: [], currentPlanId: null }),
      watch_session_features: () => null,
      unwatch_session_features: () => null,
      get_copilot_sessions: () => [],
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ =
      handlers;
  });
}

/** Seeds one feature plus whatever acceptance tests the case needs. */
async function seed(page: Page, tests: Record<string, unknown>[]) {
  await page.evaluate((tests) => {
    const backend = (window as unknown as { __WS_BACKEND__?: SeedBackend }).__WS_BACKEND__;
    if (!backend) throw new Error("Memory backend is unavailable");
    backend.seedSessionFeatures("e2e-session", {
      features: [
        {
          name: "alpha",
          hasGrillMe: true,
          hasPlan: true,
          grillMePath: "/x/alpha/grill-me.md",
          planPath: "/x/alpha/plan.md",
          planId: "alpha-plan",
          planTitle: "Alpha",
          planStatus: "active",
          planCreatedAt: "2026-09-01T10:00:00.000Z",
          derivedStatus: "active",
          todosTotal: 4,
          todosDone: 1,
          todosInProgress: 1,
          todosBlocked: 0,
        },
      ],
      currentPlanId: "alpha-plan",
    });
    if (tests.length > 0) backend.seedAcceptanceTests(tests);
  }, tests);
}

/** Opens the seeded workstream, then adds a Plan tile to it. */
async function openPlanTile(page: Page) {
  await page.locator('[data-testid="workstream-item"]').first().click();
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-plan"]').click();
}

const baseTest = (over: Record<string, unknown>) => ({
  id: "t-1",
  plan_id: "alpha-plan",
  at_id: "AT-1",
  title: "Lane colours are distinct",
  validates: "US-2",
  automation: "human-only",
  status: "not_run",
  last_run_at: null,
  evidence: null,
  notes: null,
  ...over,
});

test.describe("Plan tile acceptance tab", () => {
  test.beforeEach(async ({ page }) => {
    await configure(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("shows a plan's acceptance tests and their automation", async ({ page }) => {
    await seed(page, [
      baseTest({}),
      baseTest({ id: "t-2", at_id: "AT-2", title: "Drag files a workstream", status: "pass" }),
    ]);
    await openPlanTile(page);

    await page.locator('[data-testid="plan-tab-acceptance"]').click();
    await expect(page.getByText("Lane colours are distinct")).toBeVisible();
    await expect(page.locator('[data-testid="acceptance-automation-AT-1"]')).toHaveText(
      "human-only",
    );
    await expect(page.locator('[data-testid="acceptance-summary"]')).toContainText("1 pass");
  });

  /**
   * Marking a human-only test is the whole reason to look at this list, and the
   * result has to survive leaving the tab.
   */
  test("records a status, and it survives switching tabs", async ({ page }) => {
    await seed(page, [baseTest({})]);
    await openPlanTile(page);

    await page.locator('[data-testid="plan-tab-acceptance"]').click();
    await page.locator('[data-testid="acceptance-set-AT-1-pass"]').click();
    await expect(page.locator('[data-testid="acceptance-set-AT-1-pass"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.locator('[data-testid="plan-tab-overview"]').click();
    await page.locator('[data-testid="plan-tab-acceptance"]').click();
    await expect(page.locator('[data-testid="acceptance-set-AT-1-pass"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /** A feature planned before acceptance tests existed simply has none. */
  test("hides the tab when a feature has no acceptance tests", async ({ page }) => {
    await seed(page, []);
    await openPlanTile(page);

    await expect(page.locator('[data-testid="plan-tab-overview"]')).toBeVisible();
    await expect(page.locator('[data-testid="plan-tab-acceptance"]')).toHaveCount(0);
    // Plan and Todos are gone for every feature, tests or not.
    await expect(page.locator('[data-testid="plan-tab-plan"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="plan-tab-todos"]')).toHaveCount(0);
  });
});
