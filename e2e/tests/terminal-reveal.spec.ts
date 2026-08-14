import { expect, test } from "@playwright/test";

test("persisted terminal repaints on workstream reveal without hidden focus work", async ({ page }) => {
  await page.goto("/?harness=terminal-reveal", { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
  await page.waitForFunction(() => document.querySelector(".xterm") !== null);

  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="terminal-workstream"]');
    const host = [...(root?.querySelectorAll("div") ?? [])].find(
      (element) => "__wsTerm" in element,
    ) as (HTMLElement & { __wsTerm?: {
      refresh(start: number, end: number): void;
      focus(): void;
      write(data: string): void;
    } }) | undefined;
    if (!host?.__wsTerm) throw new Error("terminal instance not exposed");
    const term = host.__wsTerm;
    const originalRefresh = term.refresh.bind(term);
    const originalFocus = term.focus.bind(term);
    let refreshes = 0;
    let focuses = 0;
    term.refresh = (start, end) => {
      refreshes += 1;
      originalRefresh(start, end);
    };
    term.focus = () => {
      focuses += 1;
      originalFocus();
    };
    term.write("terminal reveal probe");
    (window as unknown as { __terminalProbe?: unknown }).__terminalProbe = {
      refreshes: () => refreshes,
      focuses: () => focuses,
    };
  });

  await page.locator('[data-testid="terminal-hide"]').click();
  const focusBefore = await page.evaluate(
    () => (window as unknown as { __terminalProbe: { focuses(): number } }).__terminalProbe.focuses(),
  );
  await page.waitForTimeout(100);
  const focusAfter = await page.evaluate(
    () => (window as unknown as { __terminalProbe: { focuses(): number } }).__terminalProbe.focuses(),
  );
  expect(focusAfter).toBe(focusBefore);

  const refreshBefore = await page.evaluate(
    () => (window as unknown as { __terminalProbe: { refreshes(): number } }).__terminalProbe.refreshes(),
  );
  await page.locator('[data-testid="terminal-show"]').click();
  await expect(page.locator('[data-testid="terminal-workstream"]')).toBeVisible();
  await expect.poll(
    () => page.evaluate(
      () => (window as unknown as { __terminalProbe: { refreshes(): number } }).__terminalProbe.refreshes(),
    ),
  ).toBeGreaterThanOrEqual(refreshBefore + 2);
});
