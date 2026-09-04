import { expect, test } from "./fixtures";

const WORKSTREAM_ROOT = "/demo/atlas/worktrees/checkout-reliability";

test.use({
  demoSeed: {
    projects: [
      { name: "Atlas", directory: "/demo/atlas", color: "#89b4fa" },
      { name: "Beacon", directory: "/demo/beacon", color: "#a6e3a1" },
    ],
    workstreams: [
      {
        name: "Checkout reliability",
        directory: WORKSTREAM_ROOT,
        project: "Atlas",
        workstreamType: "worktree",
        worktreeBranch: "demo/checkout-reliability",
        tiles: [
          {
            type: "copilot_session",
            title: "Checkout agent",
            config: {
              session_name: "Checkout agent",
              cwd: WORKSTREAM_ROOT,
              copilot_session_id: "demo-session-overview-001",
              is_resumed: true,
            },
          },
        ],
      },
      {
        name: "Search indexing",
        directory: "/demo/atlas/worktrees/search-indexing",
        project: "Atlas",
        workstreamType: "worktree",
        worktreeBranch: "demo/search-indexing",
      },
      {
        name: "Release readiness",
        directory: "/demo/beacon/worktrees/release-readiness",
        project: "Beacon",
        workstreamType: "worktree",
        worktreeBranch: "demo/release-readiness",
      },
    ],
    files: [
      {
        path: `${WORKSTREAM_ROOT}/retry.ts`,
        content: [
          "export const retryPolicy = {",
          "  attempts: 3,",
          "  backoffMs: [100, 250, 500],",
          "};",
          "",
        ].join("\n"),
      },
      {
        path: `${WORKSTREAM_ROOT}/retry.test.ts`,
        content: [
          'import { retryPolicy } from "./retry";',
          "",
          'test("uses bounded backoff", () => {',
          "  expect(retryPolicy.attempts).toBe(3);",
          "});",
          "",
        ].join("\n"),
      },
      {
        path: `${WORKSTREAM_ROOT}/README.md`,
        content: "# Checkout reliability\n\nSynthetic demo workspace.\n",
      },
    ],
  },
});

async function emitPtyOutput(
  page: import("@playwright/test").Page,
  tileId: string,
  output: string,
): Promise<void> {
  await page.evaluate(
    ({ id, text }) => window.__WS_EMIT__?.(`pty-output-${id}`, text),
    { id: tileId, text: output },
  );
}

test("records the workstreams overview", async ({ demo }) => {
  const { page } = demo;
  const targetWorkstream = page.getByText("Checkout reliability", {
    exact: true,
  });

  await demo.settled(targetWorkstream);
  await page.waitForTimeout(500);
  await demo.showChapter("Replace the terminal-tab pile", {
    description: "Keep each task, agent, repo, and shell together",
    duration: 900,
  });

  await targetWorkstream.click();
  const copilotTile = page.locator('[data-tile-id]').filter({
    has: page.getByText("Checkout agent", { exact: true }),
  });
  await demo.settled(copilotTile);
  const copilotTileId = await copilotTile.getAttribute("data-tile-id");
  expect(copilotTileId).not.toBeNull();
  await emitPtyOutput(
    page,
    copilotTileId!,
    [
      "\u001b[1;34mCopilot\u001b[0m  Checkout reliability",
      "",
      "User: Tighten retry handling for checkout requests.",
      "",
      "\u001b[32m●\u001b[0m Inspecting src/checkout/retry.ts",
      "\u001b[32m●\u001b[0m Updating the bounded backoff policy",
      "\u001b[90m  18 tests passed\u001b[0m",
      "",
    ].join("\r\n"),
  );
  await expect(copilotTile.locator(".xterm-rows")).toContainText(
    "18 tests passed",
  );

  const idleToggle = page.locator('[data-testid="ws-section-toggle-idle"]');
  await idleToggle.click();
  await expect(
    page.getByText("Search indexing", { exact: true }),
  ).toBeVisible();

  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-explorer"]').click();
  const explorer = page.locator('[data-testid="tile-explorer"]');
  await demo.settled(explorer);
  await expect(page.locator('[data-tile-id]')).toHaveCount(2);
  await expect(
    page.locator('[data-testid="file-tree-item"]').filter({
      hasText: "retry.ts",
    }),
  ).toBeVisible();

  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-terminal"]').click();
  await expect(page.locator('[data-tile-id]')).toHaveCount(3);
  const terminalTile = page.locator('[data-tile-id]').filter({
    has: page.getByText("Terminal 1", { exact: true }),
  });
  await demo.settled(terminalTile);
  const terminalTileId = await terminalTile.getAttribute("data-tile-id");
  expect(terminalTileId).not.toBeNull();
  await emitPtyOutput(
    page,
    terminalTileId!,
    [
      "\u001b[36m$\u001b[0m git status --short",
      " M src/checkout/retry.ts",
      "\u001b[36m$\u001b[0m npm test -- --run retry",
      "\u001b[32m ✓\u001b[0m src/checkout/retry.test.ts (6 tests)",
      "",
    ].join("\r\n"),
  );

  await expect(terminalTile.locator(".xterm-rows")).toContainText(
    "retry.test.ts (6 tests)",
  );
  await expect(copilotTile).toBeVisible();
  await expect(explorer).toBeVisible();
  await expect(terminalTile).toBeVisible();
  await demo.settled(terminalTile);
});
