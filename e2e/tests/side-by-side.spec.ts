/**
 * Side-by-side in both orientations, and resizing the split: Shift-click puts
 * two tiles next to each other, Option-click one above the other, and the
 * second status-bar button picks the stacked split. The divider resizes both.
 */
import { test, expect, type Page } from "@playwright/test";

async function start(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: {
        workstreams: [{
          name: "Split", directory: "/demo/split", loaded: true,
          tiles: [{ type: "terminal", title: "One" }, { type: "terminal", title: "Two" }, { type: "terminal", title: "Three" }],
        }],
      },
    });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.getByTestId("workstream-item").filter({ hasText: "Split" }).click();
  await expect(page.locator("[data-tile-id]")).toHaveCount(3);
}

const visible = (page: Page) => page.locator('[data-tile-id][data-hidden="false"]');
const boxes = async (page: Page) => Promise.all((await visible(page).all()).map(async (t) => (await t.boundingBox())!));

/** Clicks a tile's header (its top strip), never the terminal under it. */
async function clickTile(page: Page, index: number, modifiers: Array<"Shift" | "Alt"> = []) {
  await page.locator("[data-tile-id]").nth(index).click({ position: { x: 60, y: 10 }, modifiers });
}

test("Option-click stacks two tiles one above the other, filling the space", async ({ page }) => {
  await start(page);
  await clickTile(page, 0);
  await clickTile(page, 2, ["Alt"]);
  await expect(visible(page)).toHaveCount(2);
  const [top, bottom] = await boxes(page);
  expect(Math.abs(top.x - bottom.x)).toBeLessThan(2);
  expect(bottom.y).toBeGreaterThan(top.y + top.height - 1);
  expect(Math.abs(top.width - bottom.width)).toBeLessThan(2);
  expect(top.width).toBeGreaterThan(1000);
  await expect(page.getByTestId("toggle-sbs-horizontal")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("toggle-sbs")).toHaveAttribute("aria-pressed", "false");

  // The other button switches the same two tiles to side by side; its own exits.
  await page.getByTestId("toggle-sbs").click();
  const [left, right] = await boxes(page);
  expect(right.x).toBeGreaterThan(left.x + left.width - 1);
  await page.getByTestId("toggle-sbs").click();
  await expect(visible(page)).toHaveCount(3);
});

test("the stacked button picks two tiles, and the divider resizes both orientations", async ({ page }) => {
  await start(page);
  await page.getByTestId("toggle-sbs-horizontal").click();
  const ids = await page.locator("[data-tile-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tile-id")));
  await page.getByTestId(`tile-sbs-select-${ids[0]}`).click();
  await page.getByTestId(`tile-sbs-select-${ids[1]}`).click();
  await expect(visible(page)).toHaveCount(2);

  const divider = page.getByTestId("sbs-divider");
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const grid = (await page.getByTestId("tile-grid").boundingBox())!;
  const d = (await divider.boundingBox())!;
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, grid.y + grid.height * 0.3, { steps: 5 });
  await page.mouse.up();
  let [top, bottom] = await boxes(page);
  expect(top.height / (top.height + bottom.height)).toBeCloseTo(0.3, 1);

  // It stops short of making a tile disappear.
  await page.mouse.move(d.x + d.width / 2, grid.y + grid.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, grid.y + 2, { steps: 5 });
  await page.mouse.up();
  [top] = await boxes(page);
  expect(top.height).toBeGreaterThan(grid.height * 0.1);

  await divider.dblclick();
  [top, bottom] = await boxes(page);
  expect(Math.abs(top.height - bottom.height)).toBeLessThan(4);

  // Side by side resizes the same way, sideways; arrow keys work too.
  await page.getByTestId("toggle-sbs").click();
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  const v = (await divider.boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.mouse.down();
  await page.mouse.move(grid.x + grid.width * 0.7, v.y + v.height / 2, { steps: 5 });
  await page.mouse.up();
  let [left, right] = await boxes(page);
  expect(left.width / (left.width + right.width)).toBeCloseTo(0.7, 1);
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  [left, right] = await boxes(page);
  expect(left.width / (left.width + right.width)).toBeCloseTo(0.65, 1);
});
