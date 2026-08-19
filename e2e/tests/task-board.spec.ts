/**
 * Task board — real-browser reachability and behaviour.
 *
 * jsdom cannot see three things that have actually broken this app's UI before:
 *  - a control that renders but sits below the viewport and cannot be clicked
 *    (the sidebar prototypes shipped exactly this bug twice)
 *  - a grid whose columns collapse so cards overlap and become unhittable
 *  - a panel that mounts and immediately unmounts in a loop, which looks fine
 *    in a snapshot and is unusable in practice
 *
 * So this drives real controls at a real size and asserts the DOM settles.
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ =
      handlers;
  });
}

async function openBoard(page: Page) {
  const button = page.locator('[data-testid="task-board-button"]');
  await expect(button).toBeVisible();
  // Reachability, not mere presence: a button pushed off-screen still "exists".
  await button.click();
  await expect(page.locator('[data-testid="task-board"]')).toBeVisible();
}

async function addTask(page: Page, title: string) {
  await page.locator('[data-testid="new-task-input"]').fill(title);
  await page.locator('[data-testid="new-task-submit"]').click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
});

test("the board opens from the sidebar and shows all seven columns", async ({ page }) => {
  await openBoard(page);
  for (const id of [
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "parked",
    "delegated",
    "done",
  ]) {
    await expect(page.locator(`[data-testid="board-column-${id}"]`)).toBeVisible();
  }
});

test("a created task is clickable and opens its detail panel", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "offline sdk with mock storage");

  const card = page.locator('[data-testid^="task-card-"]').first();
  await card.click();
  await expect(page.locator('[data-testid="task-detail"]')).toBeVisible();
});

test("moving a card between columns keeps it visible and logs an event", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "media_store read API");

  await page.locator('[data-testid^="task-card-"]').first().click();
  await page.locator('[data-testid="detail-status"]').selectOption("in_review");

  // The card must survive the move rather than vanishing into a stale lane.
  // Scoped to the card because the title also appears in the detail heading.
  await expect(
    page.locator('[data-testid^="task-card-"]').getByText("media_store read API", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-testid="event-feed"]')).toContainText("in review");
});

test("a note is logged and can be deleted, but never edited", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "offline sdk write path impl");
  await page.locator('[data-testid^="task-card-"]').first().click();

  await page.locator('[data-testid="note-input"]').fill("synced with Erwin on read patterns");
  await page.locator('[data-testid="note-submit"]').click();
  await expect(page.locator('[data-testid="event-feed"]')).toContainText("synced with Erwin");

  // Immutability must hold in the real DOM, not only in the unit tests.
  await expect(page.locator('[data-testid^="event-edit-"]')).toHaveCount(0);
  const del = page.locator('[data-testid^="event-delete-"]').first();
  await del.click();
  await expect(page.locator('[data-testid="event-feed"]')).not.toContainText("synced with Erwin");
});

test("the preview renders a page and writes nothing", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "Create Kusto DB");

  await page.locator('[data-testid="devlog-preview"]').click();
  const preview = page.locator('[data-testid="devlog-preview-content"]');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("generated_by: workstreams");
  await expect(preview).toContainText("Create Kusto DB");

  // No export ran, so no status line should claim anything was written.
  await expect(page.locator('[data-testid="devlog-status"]')).toHaveCount(0);
});

test("export refuses when no devlog folder is configured", async ({ page }) => {
  // The e2e app has no devlog directory set, which is the safe default: the
  // export must say so rather than guessing a path into the user's wiki.
  await openBoard(page);
  await addTask(page, "Skills catalog");

  await page.locator('[data-testid="devlog-export"]').click();
  await expect(page.locator('[data-testid="devlog-status"]')).toContainText(/not configured/i);
});

test("the board does not churn its DOM after settling", async ({ page }) => {
  // A remount loop reads as a correct screenshot and is unusable in practice;
  // this is the failure that shipped in the Comments tab.
  await openBoard(page);
  await addTask(page, "Pipeline in media_sdk");
  await page.locator('[data-testid^="task-card-"]').first().click();

  const read = () => page.locator('[data-testid="task-board"]').innerHTML();
  const first = await read();
  await page.waitForTimeout(600);
  const second = await read();
  await page.waitForTimeout(600);
  const third = await read();

  expect(second).toBe(first);
  expect(third).toBe(second);
});
