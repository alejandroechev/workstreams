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

/** The date the export defaults to: yesterday, walked back over weekends. */
function lastWorkDayStamp(): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
});

test("the board opens from the sidebar and shows all seven columns", async ({ page }) => {
  await openBoard(page);
  for (const id of ["todo", "in_progress", "in_review", "blocked", "done"]) {
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

  await page.locator('[data-testid="log-input"]').fill("synced with Erwin on read patterns");
  await page.locator('[data-testid="log-submit"]').click();
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
  // Each task owns a heading now, rather than being a bullet under a label.
  await expect(preview).toContainText("## Create Kusto DB");

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

test("a card can be dragged to another column in a real browser", async ({ page }) => {
  // jsdom's drag events are synthetic, so only a real browser proves the
  // HTML5 drag-and-drop contract (draggable, preventDefault on dragover) is
  // actually satisfied.
  await openBoard(page);
  await addTask(page, "offline sdk with mock storage");

  const card = page.locator('[data-testid^="task-card-"]').first();
  const blocked = page.locator('[data-testid="lane-column-blocked"]').first();
  await card.dragTo(blocked);

  // The card must land in the Blocked column and carry the blocked glyph.
  const moved = page.locator('[data-testid^="task-card-"]').first();
  await expect(moved).toContainText("🧊");
  await expect(page.locator('[data-testid="lane-column-blocked"]').first()).toContainText(
    "offline sdk with mock storage",
  );
});

test("dragging to Done records the completion and keeps the card today", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "media_store read API");

  await page
    .locator('[data-testid^="task-card-"]')
    .first()
    .dragTo(page.locator('[data-testid="lane-column-done"]').first());

  await expect(page.locator('[data-testid="lane-column-done"]').first()).toContainText(
    "media_store read API",
  );
  // The move is an event, so the card is marked as touched today.
  await expect(page.locator('[data-testid^="touched-"]').first()).toBeVisible();
});

test("subtasks and their state render on the card", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "offline sdk write path impl");
  await page.locator('[data-testid^="task-card-"]').first().click();

  await page.locator('[data-testid="new-subtask-input"]').fill("Address first round of reviews");
  await page.locator('[data-testid="new-subtask-submit"]').click();
  await page.locator('[data-testid^="subtask-status-"]').first().selectOption("done");

  const card = page.locator('[data-testid^="task-card-"]').first();
  await expect(card).toContainText("Address first round of reviews");
  await expect(card).toContainText("1/1 subtasks");
  await expect(card).toContainText("✅");
});

test("creating a task from the workstream menu opens it ready to rename", async ({ page }) => {
  // The whole point of the shortcut is that it is one step, so this drives the
  // real menu rather than the board prop it eventually sets.
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill("offline-sdk-mock-store");
  await page.locator('[data-testid="ws-create-submit"]').click();

  const row = page.locator('[data-testid="workstream-item"]', {
    hasText: "offline-sdk-mock-store",
  });
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator('[data-testid^="ws-actions-"]').click();
  await page.locator('[data-testid="action-create-task"]').click();

  // The board opens with the task created, selected, and named after the
  // workstream, with the workstream already attached.
  await expect(page.locator('[data-testid="task-board"]')).toBeVisible();
  await expect(page.locator('[data-testid="detail-title"]')).toHaveValue("offline-sdk-mock-store");
  await expect(page.locator('[data-testid="detail-workstream"]')).not.toHaveValue("");
  await expect(page.locator('[data-testid="detail-open-workstream"]')).toBeVisible();

  // And the title is editable straight away.
  await page.locator('[data-testid="detail-title"]').fill("media_store read API");
  await page.locator('[data-testid="detail-title"]').press("Enter");
  await expect(
    page.locator('[data-testid^="task-card-"]').filter({ hasText: "media_store read API" }),
  ).toBeVisible();
});

test("reopening the board does not create the task again", async ({ page }) => {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill("dup-check");
  await page.locator('[data-testid="ws-create-submit"]').click();

  const row = page.locator('[data-testid="workstream-item"]', { hasText: "dup-check" });
  await row.hover();
  await row.locator('[data-testid^="ws-actions-"]').click();
  await page.locator('[data-testid="action-create-task"]').click();
  await expect(page.locator('[data-testid="detail-title"]')).toHaveValue("dup-check");

  await page.locator('[data-testid="board-close"]').click();
  await page.locator('[data-testid="task-board-button"]').click();

  // A replayed request would silently accumulate a duplicate on every open.
  await expect(page.locator('[data-testid^="task-card-"]')).toHaveCount(1);
});

test("a multi-line note survives editing and reaches the exported page", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "media_store read API");
  await page.locator('[data-testid^="task-card-"]').first().click();

  const notes = page.locator('[data-testid="detail-notes"]');
  await notes.fill("sync with Erwin on read patterns\ngather precise requirements");
  await notes.blur();

  // Editable, unlike the append-only log.
  await notes.fill("revised: read path is blocked on the permit system");
  await notes.blur();
  await expect(page.locator('[data-testid^="card-has-notes-"]')).toBeVisible();

  await page.locator('[data-testid="devlog-preview"]').click();
  const preview = page.locator('[data-testid="devlog-preview-content"]');
  await expect(preview).toContainText("revised: read path is blocked on the permit system");
  await expect(preview).not.toContainText("sync with Erwin on read patterns");
});

test("Enter inside the note box stays a newline", async ({ page }) => {
  // A textarea that submitted on Enter could never hold more than one line,
  // which is the entire point of the field.
  await openBoard(page);
  await addTask(page, "offline sdk write path impl");
  await page.locator('[data-testid^="task-card-"]').first().click();

  const notes = page.locator('[data-testid="detail-notes"]');
  await notes.click();
  await notes.type("first line");
  await notes.press("Enter");
  await notes.type("second line");

  await expect(notes).toHaveValue("first line\nsecond line");
  await expect(page.locator('[data-testid="event-feed"]')).not.toContainText("first line");
});

test("notes and the activity log stay separate", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "Create Kusto DB");
  await page.locator('[data-testid^="task-card-"]').first().click();

  await page.locator('[data-testid="detail-notes"]').fill("blocked on a subscription");
  await page.locator('[data-testid="detail-notes"]').blur();
  await page.locator('[data-testid="log-input"]').fill("chased the subscription request");
  await page.locator('[data-testid="log-submit"]').click();

  // Editing the note must not appear in the log, and vice versa.
  const feed = page.locator('[data-testid="event-feed"]');
  await expect(feed).toContainText("chased the subscription request");
  await expect(feed).not.toContainText("blocked on a subscription");
  await expect(page.locator('[data-testid="detail-notes"]')).toHaveValue(
    "blocked on a subscription",
  );
});

/** Create a workstream and return its sidebar row. */
async function createWorkstream(page: Page, name: string) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill(name);
  await page.locator('[data-testid="ws-create-submit"]').click();
  const row = page.locator('[data-testid="workstream-item"]', { hasText: name });
  await expect(row).toBeVisible();
  return row;
}

test("the quick note lives in the bottom bar and is actually usable", async ({ page }) => {
  // It now competes for width with the tile controls, so "renders" is not
  // enough -- it has to be reachable and typeable at a real viewport size.
  const row = await createWorkstream(page, "quick-note-host");
  await row.hover();
  await row.locator('[data-testid^="ws-actions-"]').click();
  await page.locator('[data-testid="action-create-task"]').click();
  await page.locator('[data-testid="board-close"]').click();

  // In the status bar, beside the tile controls, not in its own strip.
  const slot = page.locator('[data-testid="status-bar"] [data-testid="quick-note"]');
  await expect(slot).toBeVisible();
  await expect(slot.locator('[data-testid="quick-note-input"]')).toBeVisible();
  await expect(page.locator('[data-testid="add-tile-button"]')).toBeVisible();

  const input = slot.locator('[data-testid="quick-note-input"]');
  await input.click();
  await input.fill("logged straight from the status bar");
  await input.press("Enter");
  await expect(page.locator('[data-testid="quick-note-flash"]')).toBeVisible();

  // And it reached the task's activity log.
  await page.locator('[data-testid="task-board-button"]').click();
  await page.locator('[data-testid^="task-card-"]').first().click();
  await expect(page.locator('[data-testid="event-feed"]')).toContainText(
    "logged straight from the status bar",
  );
});

test("no quick note appears for a workstream with no task", async ({ page }) => {
  // Most workstreams have no bound task, and a permanent empty prompt on all
  // of them is exactly the noise that motivated moving it off its own strip.
  await createWorkstream(page, "taskless");

  await expect(page.locator('[data-testid="add-tile-button"]')).toBeVisible();
  await expect(page.locator('[data-testid="quick-note"]')).toHaveCount(0);
});

test("the exported page defaults to the last work day and uses the sectioned format", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "Agency Code Review Telemetry");
  await page.locator('[data-testid^="task-card-"]').first().click();

  await page.locator('[data-testid="new-subtask-input"]').fill("ACSMediaSDK Pipeline");
  await page.locator('[data-testid="new-subtask-submit"]').click();
  await page
    .locator('[data-testid="detail-notes"]')
    .fill("I am exploring some improvements:\n- Moving the miner logic to a shared repo\n- Adding tests");
  await page.locator('[data-testid="detail-notes"]').blur();

  await page.locator('[data-testid="devlog-preview"]').click();
  const preview = page.locator('[data-testid="devlog-preview-content"]');

  // The last work day, because the export runs before the new day's work
  // starts -- and on a Monday that means Friday, not an empty Sunday.
  const stamp = lastWorkDayStamp();
  await expect(preview).toContainText(`date: ${stamp}`);
  await expect(preview).toContainText(`# ${stamp}`);

  await expect(preview).toContainText("## Agency Code Review Telemetry");
  await expect(preview).toContainText("### Subtasks");
  await expect(preview).toContainText("### Notes");
  await expect(preview).toContainText("I am exploring some improvements:");
  // A note that already contains bullets must not be bulleted again.
  await expect(preview).not.toContainText("- - Moving");
});

test("a bound workstream offers Go to task instead of Create task", async ({ page }) => {
  const row = await createWorkstream(page, "bound-ws");

  await row.hover();
  await row.locator('[data-testid^="ws-actions-"]').click();
  await expect(page.locator('[data-testid="action-create-task"]')).toBeVisible();
  await expect(page.locator('[data-testid="action-go-to-task"]')).toHaveCount(0);
  await page.locator('[data-testid="action-create-task"]').click();

  await page.locator('[data-testid="detail-title"]').fill("Offline SDK Read Mock Storage");
  await page.locator('[data-testid="detail-title"]').press("Enter");
  await page.locator('[data-testid="board-close"]').click();

  // Now bound: the menu must swap, since a second task could never be created.
  await row.hover();
  await row.locator('[data-testid^="ws-actions-"]').click();
  await expect(page.locator('[data-testid="action-create-task"]')).toHaveCount(0);
  await page.locator('[data-testid="action-go-to-task"]').click();

  await expect(page.locator('[data-testid="task-board"]')).toBeVisible();
  await expect(page.locator('[data-testid="detail-title"]')).toHaveValue(
    "Offline SDK Read Mock Storage",
  );
  // It selects, never creates.
  await expect(page.locator('[data-testid^="task-card-"]')).toHaveCount(1);
});

test("the notes box grows to fill the detail panel", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "task with notes");
  await page.locator('[data-testid^="task-card-"]').first().click();

  const box = page.locator('[data-testid="detail-notes"]');
  const panel = page.locator('[data-testid="task-detail"]');
  const boxHeight = (await box.boundingBox())!.height;
  const panelHeight = (await panel.boundingBox())!.height;

  // Not a fixed six rows: it should claim a real share of the panel.
  expect(boxHeight).toBeGreaterThan(150);
  expect(boxHeight).toBeGreaterThan(panelHeight * 0.2);
  // And it must not overflow the panel it lives in.
  expect(boxHeight).toBeLessThanOrEqual(panelHeight);
});

test("every column stays on screen with the detail panel open", async ({ page }) => {
  // Adding an eighth column pushed Done off the right edge at 1280 wide once
  // the 320px detail panel opened. Columns that exist but cannot be seen are
  // the failure mode the sidebar prototypes shipped twice.
  await openBoard(page);
  await addTask(page, "a task");
  await page.locator('[data-testid^="task-card-"]').first().click();
  await expect(page.locator('[data-testid="task-detail"]')).toBeVisible();

  for (const id of ["todo", "in_progress", "in_review", "blocked", "done"]) {
    // ratio 1: the default accepts ANY intersection, so a column clipped to
    // its first two letters would still pass.
    await expect(page.locator(`[data-testid="board-column-${id}"]`)).toBeInViewport({ ratio: 1 });
  }
});

test("either day can be exported, and the preview follows the choice", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "Agency Code Review Telemetry");
  await page.locator('[data-testid^="task-card-"]').first().click();
  await page.locator('[data-testid="log-input"]').fill("logged just now");
  await page.locator('[data-testid="log-submit"]').click();

  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const lastWorkDay = lastWorkDayStamp();

  const preview = page.locator('[data-testid="devlog-preview-content"]');
  await page.locator('[data-testid="devlog-preview"]').click();

  // Defaults to the last work day, so an entry logged just now is absent.
  await expect(page.locator('[data-testid="devlog-day-label"]')).toHaveText(lastWorkDay);
  await expect(preview).toContainText(`# ${lastWorkDay}`);
  await expect(preview).not.toContainText("logged just now");

  // Switching re-renders the open preview rather than leaving a stale page up.
  await page.locator('[data-testid="devlog-day"]').selectOption("today");
  await expect(page.locator('[data-testid="devlog-day-label"]')).toHaveText(stamp(now));
  await expect(preview).toContainText(`# ${stamp(now)}`);
  await expect(preview).toContainText("logged just now");
});

test("the activity feed shows today, with earlier entries a click away", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "Offline SDK Read Mock Storage");
  await page.locator('[data-testid^="task-card-"]').first().click();

  await page.locator('[data-testid="log-input"]').fill("today's entry");
  await page.locator('[data-testid="log-submit"]').click();

  const feed = page.locator('[data-testid="event-feed"]');
  await expect(feed).toContainText("today's entry");
  // Everything here is from today, so there is nothing to hide behind a toggle.
  await expect(page.locator('[data-testid="event-show-all"]')).toHaveCount(0);
});

test("in-progress tasks are always visible under the Tasks button", async ({ page }) => {
  const row = await createWorkstream(page, "offline-sdk-ws");
  await row.hover();
  await row.locator('[data-testid^="ws-actions-"]').click();
  await page.locator('[data-testid="action-create-task"]').click();

  await page.locator('[data-testid="detail-title"]').fill("Offline SDK Read Mock Storage");
  await page.locator('[data-testid="detail-title"]').press("Enter");
  await page.locator('[data-testid="detail-status"]').selectOption("in_progress");
  await page.locator('[data-testid="board-close"]').click();

  // The list is in the sidebar, not behind the board, and reachable at a real
  // viewport size rather than merely present in the DOM.
  const list = page.locator('[data-testid="in-progress-list"]');
  await expect(list).toBeVisible();
  const entry = list.locator('[data-testid^="in-progress-task-"]');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("Offline SDK Read Mock Storage");
  await expect(entry).toContainText("ws:offline-sdk-ws");

  // Clicking navigates to the bound workstream.
  await entry.click();
  await expect(entry).toHaveAttribute("data-active", "true");
});

test("the in-progress list stays put and drops finished work", async ({ page }) => {
  await openBoard(page);
  await addTask(page, "a task in flight");
  await page.locator('[data-testid^="task-card-"]').first().click();
  await page.locator('[data-testid="detail-status"]').selectOption("in_progress");
  await page.locator('[data-testid="board-close"]').click();

  const list = page.locator('[data-testid="in-progress-list"]');
  await expect(list.locator('[data-testid^="in-progress-task-"]')).toHaveCount(1);

  // Finishing it must remove the row without the app being reloaded.
  await page.locator('[data-testid="task-board-button"]').click();
  await page.locator('[data-testid^="task-card-"]').first().click();
  await page.locator('[data-testid="detail-status"]').selectOption("done");
  await page.locator('[data-testid="board-close"]').click();

  await expect(list.locator('[data-testid^="in-progress-task-"]')).toHaveCount(0);
  // Always on: it shows an empty state rather than collapsing.
  await expect(page.locator('[data-testid="in-progress-empty"]')).toBeVisible();
});

test("the export day picker says Last work day", async ({ page }) => {
  await openBoard(page);
  await expect(page.locator('[data-testid="devlog-day"]')).toHaveValue("yesterday");
  await expect(page.locator('[data-testid="devlog-day-label"]')).toHaveText(lastWorkDayStamp());
});
