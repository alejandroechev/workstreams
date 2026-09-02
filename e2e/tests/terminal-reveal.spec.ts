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

test("refocus resynchronizes xterm dimensions with the PTY", async ({ page }) => {
  await page.goto("/?harness=terminal-reveal", { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".xterm") !== null);
  // Let mount + reveal recovery settle so only the explicit refocus below can
  // produce the resize call under test.
  await page.waitForTimeout(600);

  const expectedCols = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="terminal-workstream"]');
    const host = [...(root?.querySelectorAll("div") ?? [])].find(
      (element) => "__wsTerm" in element,
    ) as (HTMLElement & {
      __wsTerm?: { cols: number; rows: number; resize(cols: number, rows: number): void };
    }) | undefined;
    if (!host?.__wsTerm) throw new Error("terminal instance not exposed");
    const term = host.__wsTerm;
    const fittedCols = term.cols;
    term.resize(Math.max(2, fittedCols - 7), term.rows);
    (window as unknown as { __WS_INVOKE_LOG__?: unknown[] }).__WS_INVOKE_LOG__ = [];
    return fittedCols;
  });

  await page.waitForTimeout(150);
  expect(await page.evaluate(() =>
    ((window as unknown as {
      __WS_INVOKE_LOG__?: Array<{ cmd: string }>;
    }).__WS_INVOKE_LOG__ ?? []).filter((call) => call.cmd === "resize_pty").length,
  )).toBe(0);

  await page.locator('[data-testid="terminal-refocus"]').click();

  await expect.poll(() =>
    page.evaluate(() => {
      const calls = (window as unknown as {
        __WS_INVOKE_LOG__?: Array<{
          cmd: string;
          args: { cols?: number };
        }>;
      }).__WS_INVOKE_LOG__ ?? [];
      return calls
        .filter((call) => call.cmd === "resize_pty")
        .at(-1)?.args.cols ?? null;
    }),
  ).toBe(expectedCols);
});
