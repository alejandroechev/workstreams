/**
 * Sidebar status sections + Repo Manager (option A1).
 *
 * Two things jsdom cannot check and that broke the prototypes of this design:
 *  - the footer repo control must be REACHABLE, not merely present. A layout
 *    that overflows its container pushes it below the viewport where it cannot
 *    be clicked at all.
 *  - the sidebar must never render empty on a cold start, when nothing is
 *    loaded and therefore every workstream is idle.
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
  });
}

/** The e2e app boots with no workstreams; make one so the sections have rows. */
async function createWorkstream(page: Page, name: string) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill(name);
  await page.locator('[data-testid="ws-create-submit"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="workstream-item"]', { hasText: name })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
});

test.describe("Sidebar status sections", () => {
  test("renders Live and Idle sections with counts", async ({ page }) => {
    await expect(page.locator('[data-testid="ws-section-live"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-section-idle"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-section-count-live"]')).toBeVisible();
  });

  test("a newly created workstream is visible in a section", async ({ page }) => {
    await createWorkstream(page, "Section Demo");

    const live = Number(await page.locator('[data-testid="ws-section-count-live"]').innerText());
    const idle = Number(await page.locator('[data-testid="ws-section-count-idle"]').innerText());
    expect(live + idle).toBeGreaterThan(0);
    // Whichever section owns it, the row itself must be on screen — a section
    // that hides every row is the failure mode this guards.
    await expect(page.locator('[data-testid="workstream-item"]', { hasText: "Section Demo" })).toBeVisible();
  });

  test("a section can be collapsed and expanded", async ({ page }) => {
    await createWorkstream(page, "Toggle Demo");
    const before = await page.locator('[data-testid="workstream-item"]').count();
    expect(before).toBeGreaterThan(0);

    // Collapse whichever section currently holds rows.
    const liveCount = Number(await page.locator('[data-testid="ws-section-count-live"]').innerText());
    const key = liveCount > 0 ? "live" : "idle";

    await page.locator(`[data-testid="ws-section-toggle-${key}"]`).click();
    await expect
      .poll(() => page.locator('[data-testid="workstream-item"]').count())
      .toBeLessThan(before);

    await page.locator(`[data-testid="ws-section-toggle-${key}"]`).click();
    await expect
      .poll(() => page.locator('[data-testid="workstream-item"]').count())
      .toBe(before);
  });
});

test.describe("Repo Manager", () => {
  // Laptop heights are where the prototype's bottom control went off-screen.
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1180, height: 700 },
  ]) {
    test(`footer control is reachable at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      const button = page.locator('[data-testid="repo-manager-button"]');
      await expect(button).toBeVisible();

      const reachable = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="repo-manager-button"]');
        if (!el) return { ok: false, why: "missing" };
        const r = el.getBoundingClientRect();
        if (r.bottom > window.innerHeight || r.top < 0) {
          return { ok: false, why: `offscreen (bottom ${Math.round(r.bottom)} > ${window.innerHeight})` };
        }
        const top = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2),
        );
        return { ok: !!top && (el === top || el.contains(top) || top.contains(el)), why: "occluded" };
      });
      expect(reachable.ok, reachable.why).toBe(true);

      // And it must actually do something.
      await button.click();
      await expect(page.locator('[data-testid="repo-manager-panel"]')).toBeVisible();
    });
  }

  test("lists repos, filters them, and edits one", async ({ page }) => {
    await page.locator('[data-testid="repo-manager-button"]').click();
    const panel = page.locator('[data-testid="repo-manager-panel"]');
    await expect(panel).toBeVisible();

    const rows = panel.locator('[data-testid^="repo-manager-row-"]');
    await expect(rows.first()).toBeVisible();

    await panel.locator('[data-testid="repo-manager-search"]').fill("zzz-no-such-repo");
    await expect(panel.locator('[data-testid="repo-manager-empty"]')).toBeVisible();

    await panel.locator('[data-testid="repo-manager-search"]').fill("");
    await rows.first().click();
    await panel.locator('[data-testid="repo-manager-name"]').fill("Renamed Repo");
    await panel.locator('[data-testid="repo-manager-save"]').click();

    await page.locator('[data-testid="repo-manager-close"]').click();
    await expect(panel).toHaveCount(0);
  });

  test("closes on Escape", async ({ page }) => {
    await page.locator('[data-testid="repo-manager-button"]').click();
    await expect(page.locator('[data-testid="repo-manager-panel"]')).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="repo-manager-panel"]')).toHaveCount(0);
  });
});
