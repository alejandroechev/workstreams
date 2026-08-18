/**
 * Inline-comment interactivity (regression gate).
 *
 * Reproduces the class of bug that jsdom unit tests cannot see: buttons inside
 * Monaco **view zones** were unclickable because the text layer (`.view-lines`)
 * painted on top of the zone DOM. These specs drive the isolated harness routes
 * (`?harness=<case>`) with REAL Monaco and assert a real click produces a state
 * change — so the fix can't silently regress.
 *
 * Uses the same VITE_E2E dev server as the other e2e specs (see
 * playwright.config.ts webServer).
 */
import { test, expect, type Page } from "@playwright/test";

async function openCase(page: Page, id: string) {
  await page.goto(`/?harness=${id}`, { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
  // Real Monaco must mount (the whole point — not a jsdom mock).
  await page.waitForFunction(
    () => document.querySelectorAll(".monaco-editor").length > 0,
    null,
    { timeout: 30_000 },
  );
}

test.describe("inline comment interactivity", () => {
  test("Repo Explorer file-comment Edit button is clickable and opens the composer", async ({ page }) => {
    await openCase(page, "comment-zone");

    const edit = page.locator('[data-testid="comment-edit-c1"]');
    await expect(edit).toBeVisible();

    // The button center must be the top element (not occluded by a Monaco layer).
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-edit-c1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Edit button is occluded by a Monaco layer").toBe(false);

    // A real click (Playwright fails if occluded) must open the inline composer.
    await edit.click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="comment-composer"]')).toBeVisible();
  });

  test("Repo Explorer file-comment renders the agent reply and Resolve flips the status", async ({ page }) => {
    await openCase(page, "comment-zone");

    // The threaded agent reply renders inside the same view zone as the note.
    await expect(page.locator('[data-testid="comment-entry-a1"]')).toBeVisible();
    await expect(page.locator('[data-testid="comment-entry-a1"]')).toContainText("Renamed");

    // Resolve is the reviewer's own note action; clicking it must not be
    // occluded and must flip the reviewer note's status to resolved (which
    // swaps the button to Reopen).
    const resolve = page.locator('[data-testid="comment-resolve-c1"]');
    await expect(resolve).toBeVisible();
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-resolve-c1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Resolve button is occluded by a Monaco layer").toBe(false);

    await resolve.click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="comment-reopen-c1"]')).toBeVisible();
  });

  test("multi-reply comment thread does not overlap the following code lines", async ({ page }) => {
    await openCase(page, "comment-zone");
    // The harness thread has a root + two replies; its view zone must reserve
    // enough vertical space that no code line renders on top of it (regression
    // guard for the height under-estimate that put replies over the code).
    await expect(page.locator('[data-testid="comment-entry-a2"]')).toContainText("looks good");

    // Poll until the async height-measurement pass has settled (rAF), then
    // assert no code line overlaps the zone.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const zone = document.querySelector('[data-testid="comment-zone-c1"]');
            if (!zone) return ["<no-zone>"];
            const z = zone.getBoundingClientRect();
            return [...document.querySelectorAll(".view-line")]
              .map((l) => ({ t: (l.textContent || "").trim(), r: l.getBoundingClientRect() }))
              .filter((l) => l.t.length > 0)
              // A code line overlaps if its vertical span intersects the zone's.
              .filter((l) => l.r.bottom > z.top + 2 && l.r.top < z.bottom - 2)
              .map((l) => l.t);
          }),
        { timeout: 5_000 },
      )
      .toEqual([]);
  });

  test("Repo Explorer file-comment Reply button opens the composer and adds a threaded reply", async ({ page }) => {
    await openCase(page, "comment-zone");

    const reply = page.locator('[data-testid="comment-reply-c1"]');
    await expect(reply).toBeVisible();
    // Not occluded by a Monaco layer.
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-reply-c1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Reply button is occluded by a Monaco layer").toBe(false);

    await reply.click({ timeout: 5_000 });
    const composer = page.locator('[data-testid="comment-composer"]');
    await expect(composer).toBeVisible();
    await expect(composer).toContainText("Replying to comment");

    await page.locator('[data-testid="comment-composer-textarea"]').fill("Looks good, thanks!");
    await page.locator('[data-testid="comment-composer-save"]').click();

    // The new reviewer reply renders inside the same thread zone.
    await expect(
      page.locator('[data-testid="comment-zone-c1"]'),
    ).toContainText("Looks good, thanks!");
  });

  test("Repo Explorer file-comment Copy button is present and clickable", async ({ page }) => {
    await openCase(page, "comment-zone");
    const copy = page.locator('[data-testid="comment-copy-c1"]');
    await expect(copy).toBeVisible();
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-copy-c1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Copy button is occluded by a Monaco layer").toBe(false);
    // Clicking must not throw (clipboard write is best-effort in the shim).
    await copy.click({ timeout: 5_000 });
  });

  test("Code Review thread Resolve button is clickable and flips the status", async ({ page }) => {
    await openCase(page, "review-thread");

    const resolve = page.locator('[data-testid="resolve"]');
    await expect(resolve).toBeVisible();

    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="resolve"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Resolve button is occluded by a Monaco layer").toBe(false);

    await resolve.click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="thread-status"]').first()).toHaveText("Resolved");
  });

  test("Repo Explorer Unstaged diff renders editable file-comment threads", async ({ page }) => {
    await page.goto("/?harness=diff-comment-zone", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
    await page.locator('[data-testid="repo-explorer-tab-diff"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll(".monaco-diff-editor").length > 0,
      null,
      { timeout: 30_000 },
    );

    const toggle = page.locator('[data-testid="repo-explorer-diff-comments-toggle"]');
    await expect(toggle).toBeEnabled();
    await toggle.click();

    const edit = page.locator('[data-testid^="comment-edit-"]');
    await expect(edit).toBeVisible();
    await expect(page.locator('[data-testid^="comment-zone-"]')).toContainText(
      "This comment came from the working file.",
    );
    await edit.click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="comment-composer"]')).toBeVisible();
  });

  test("Repo Explorer Unstaged diff saves a comment edit and closes the composer", async ({ page }) => {
    await page.goto("/?harness=diff-comment-zone", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
    await page.locator('[data-testid="repo-explorer-tab-diff"]').click();
    await page.locator('[data-testid="repo-explorer-diff-comments-toggle"]').click();

    await page.locator('[data-testid^="comment-edit-"]').click();
    await page.locator('[data-testid="comment-composer-textarea"]').fill(
      "Edited and saved from the unstaged diff.",
    );
    await page.locator('[data-testid="comment-composer-save"]').click();

    await expect(page.locator('[data-testid="comment-composer"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="comment-zone-"]')).toContainText(
      "Edited and saved from the unstaged diff.",
    );
  });

  test("Repo Explorer Unstaged diff captures Cmd+S while Monaco is focused", async ({ page }) => {
    await page.goto("/?harness=diff-comment-zone", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
    await page.locator('[data-testid="repo-explorer-tab-diff"]').click();

    const prevented = await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".monaco-diff-editor .modified textarea",
      );
      if (!input) return false;
      input.focus();
      const event = new KeyboardEvent("keydown", {
        key: "s",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    });

    expect(prevented).toBe(true);
  });

  test("Repo Explorer selects a custom target branch for historical diff", async ({ page }) => {
    await page.goto("/?harness=diff-comment-zone", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
    await page.locator('[data-testid="repo-explorer-tab-diff"]').click();

    const picker = page.getByLabel("Custom diff target branch");
    await expect(picker).toContainText("release/1.0");
    await picker.selectOption("release/1.0");

    await expect(picker).toHaveValue("release/1.0");
    await expect(page.locator('[data-testid="diff-current-file"]')).toHaveText("example.ts");
    await expect(page.getByLabel("Save diff edit")).toHaveCount(0);
    await expect(
      page.locator('[data-testid="repo-explorer-diff-comments-toggle"]'),
    ).toHaveCount(0);
  });
});

test.describe("imported review comments (ado-file-comments)", () => {
  test("shows the external reviewer's name and keeps the agent reply above a later tile reply", async ({
    page,
  }) => {
    await openCase(page, "imported-comment-zone");

    const zone = page.locator('[data-testid="comment-zone-ado-1513151-16261206-1"]');
    await expect(zone).toBeVisible();

    // BUG 1: imported comments were attributed to this user ("you"). Assert on
    // the ROOT's meta line specifically — "you" is still correct for the
    // reviewer's own reply further down the same thread.
    const rootMeta = page.locator('[data-testid="comment-meta-ado-1513151-16261206-1"]');
    await expect(rootMeta).toHaveText("Eduardo Fernandez · open");
    // The agent reply keeps its own identity.
    await expect(page.locator('[data-testid="comment-meta-agent-reply"]')).toHaveText("agent · open");

    // BUG 2: the agent reply (ISO-8601) must render above the reviewer reply
    // written later in the tile (legacy epoch seconds). String ordering put
    // every epoch row first, so the follow-up appeared before the answer.
    const text = (await zone.innerText()).replace(/\s+/g, " ");
    expect(text).toContain("AGENT_ANSWER");
    expect(text).toContain("MY_FOLLOW_UP");
    expect(text.indexOf("AGENT_ANSWER")).toBeLessThan(text.indexOf("MY_FOLLOW_UP"));
  });
});

/**
 * Comments-tab variant of {@link openCase}: this harness renders no editor
 * until a thread is picked, mirroring the real tab, so waiting for Monaco up
 * front would hang.
 */
async function openCommentsCase(page: Page) {
  await page.goto("/?harness=comments-navigation", { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
  await expect(page.locator('[data-testid="comments-panel"]')).toBeVisible();
}

test.describe("Comments tab navigation", () => {
  test("clicking a thread reveals its line in real Monaco and focuses that thread", async ({
    page,
  }) => {
    await openCommentsCase(page);

    // Threads are grouped by file, so a comment on another file is listed too.
    await expect(page.locator('[data-testid="comments-file-src/example.ts"]')).toBeVisible();
    await expect(page.locator('[data-testid="comments-file-src/other.ts"]')).toBeVisible();

    // Monaco creates a view zone per comment regardless of scroll position, and
    // it VIRTUALIZES scrolling (scrollTop stays 0 while the rendered line
    // window moves). So the honest proof of "reveal" is that the first rendered
    // line changed — the editor really moved to the anchor.
    // Read the gutter rather than the code text: Monaco renders non-breaking
    // spaces inside .view-line, which makes string comparison deceptive.
    const topLineNumber = async () =>
      page.evaluate(() => {
        const nums = Array.from(document.querySelectorAll(".line-numbers"))
          .map((el) => Number(el.textContent?.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
        return nums.length > 0 ? Math.min(...nums) : 0;
      });
    // Open the file via a near-top comment first, so the baseline is line 1.
    await page.locator('[data-testid="comments-thread-near-top"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".monaco-editor").length > 0, null, {
      timeout: 30_000,
    });
    await expect.poll(topLineNumber, { timeout: 10_000 }).toBe(1);

    await page.locator('[data-testid="comments-thread-far-down"]').click();

    // Anchor is line 48, so the rendered window must move well down the file.
    await expect.poll(topLineNumber, { timeout: 10_000 }).toBeGreaterThan(10);

    // ...and that the clicked thread is the one marked focused.
    const zone = page.locator('[data-testid="comment-zone-far-down"]');
    await expect(zone).toBeVisible({ timeout: 10_000 });
    await expect(zone).toHaveAttribute("data-focused", "true");
    await expect(page.locator('[data-testid="comment-zone-near-top"]')).toHaveAttribute(
      "data-focused",
      "false",
    );

    // The panel keeps its own selection in sync.
    await expect(page.locator('[data-testid="comments-thread-far-down"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  test("imported authors render by name in the navigation list", async ({ page }) => {
    await openCommentsCase(page);

    await expect(page.locator('[data-testid="comments-thread-near-top"]')).toContainText(
      "Eduardo Fernandez",
    );
  });
});

test.describe("resolving imported comments", () => {
  test("an imported comment can be resolved even though it is not mine", async ({ page }) => {
    await openCase(page, "imported-comment-zone");

    const resolve = page.locator('[data-testid="comment-resolve-ado-1513151-16261206-1"]');
    await expect(resolve).toBeVisible();

    // The button must be genuinely clickable inside the Monaco view zone, not
    // merely present (the class of bug this harness exists for).
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-resolve-ado-1513151-16261206-1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(
        Math.round(r.left + r.width / 2),
        Math.round(r.top + r.height / 2),
      );
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Resolve button is occluded by a Monaco layer").toBe(false);

    await resolve.click({ timeout: 5_000 });

    // Round-trips to Reopen, proving the status actually changed.
    await expect(
      page.locator('[data-testid="comment-reopen-ado-1513151-16261206-1"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="comment-meta-ado-1513151-16261206-1"]'),
    ).toHaveText("Eduardo Fernandez · resolved");
  });

  test("someone else's comment still cannot be edited or deleted", async ({ page }) => {
    await openCase(page, "imported-comment-zone");

    await expect(page.locator('[data-testid="comment-edit-ado-1513151-16261206-1"]')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="comment-delete-ado-1513151-16261206-1"]'),
    ).toHaveCount(0);
  });
});
