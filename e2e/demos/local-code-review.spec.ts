import { expect, test } from "./fixtures";

const WORKSTREAM_ROOT = "/demo/orbit/worktrees/input-validation";
const REVIEW_FILE = "src/validation.ts";
const REVIEW_COMMENT = "Return a typed error so callers can explain why validation failed.";

test.use({
  demoSeed: {
    projects: [
      { name: "Orbit", directory: "/demo/orbit", color: "#89b4fa" },
    ],
    workstreams: [
      {
        name: "Input validation",
        directory: WORKSTREAM_ROOT,
        project: "Orbit",
        workstreamType: "worktree",
        worktreeBranch: "demo/input-validation",
        tiles: [{ type: "code_review", title: "Code Review" }],
      },
    ],
  },
});

async function seedWorkingTreeDiff(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(
    async ({ file }) => {
      const backend = (window as unknown as {
        __WS_BACKEND__?: {
          listWorkstreams: () => Promise<Array<{ id: string; name: string }>>;
          seedBoundSession: (workstreamId: string, sessionId: string) => void;
          seedReviewDiff: (
            files: Array<{ path: string; status: "M" }>,
          ) => void;
          seedReviewDiffSides: (
            filePath: string,
            sides: { before: string; after: string },
          ) => void;
        };
      }).__WS_BACKEND__;
      if (!backend) throw new Error("Synthetic MemoryBackend is unavailable");

      const workstream = (await backend.listWorkstreams()).find(
        (candidate) => candidate.name === "Input validation",
      );
      if (!workstream) throw new Error("Synthetic workstream is unavailable");

      backend.seedBoundSession(
        workstream.id,
        "demo-session-code-review-001",
      );
      backend.seedReviewDiff([{ path: file, status: "M" }]);
      backend.seedReviewDiffSides(file, {
        before: [
          "export function parseRequest(input: string) {",
          "  const trimmed = input.trim();",
          "  return JSON.parse(trimmed);",
          "}",
          "",
        ].join("\n"),
        after: [
          "export function parseRequest(input: string) {",
          "  const trimmed = input.trim();",
          "  if (!trimmed) return null;",
          "  return JSON.parse(trimmed);",
          "}",
          "",
        ].join("\n"),
      });
    },
    { file: REVIEW_FILE },
  );
}

test("records a local working-tree code review", async ({ demo }) => {
  const { page } = demo;
  const workstream = page.getByText("Input validation", { exact: true });

  await seedWorkingTreeDiff(page);
  await demo.settled(workstream);
  await page.screencast.showChapter("Review changes without a PR", {
    description: "Open a working-tree diff and leave feedback inline",
    duration: 800,
  });
  await workstream.click();
  const tile = page.locator('[data-tile-id]').filter({
    has: page.locator('[data-testid="code-review-tile"]'),
  });
  await demo.settled(tile);
  await tile.click();
  await page.locator('[data-testid="toggle-fullscreen"]').click();
  await expect(page.getByText("⛶ Full", { exact: true })).toBeVisible();

  await expect(tile.locator('[data-testid="review-picker"]')).toBeVisible();
  await tile.locator('[data-testid="create-review"]').click();
  await expect(tile.locator('[data-testid="review-source"]')).toHaveText(
    "working_tree",
  );
  await expect(tile.locator(`[data-testid="file-${REVIEW_FILE}"]`)).toBeVisible();

  const modifiedEditor = tile.locator(".editor.modified");
  await expect(modifiedEditor).toBeVisible();
  const addedLine = modifiedEditor.locator(".view-line").filter({
    hasText: "if (!trimmed) return null;",
  });
  await expect(addedLine).toBeVisible();
  await addedLine.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");

  const commentButton = tile.locator('[data-testid="add-comment-floating"]');
  await expect(commentButton).toHaveText("+ Comment (3)");
  await commentButton.click();
  await tile.locator('[data-testid="comment-body"]').fill(REVIEW_COMMENT);
  await tile.locator('[data-testid="add-comment"]').click();

  const thread = tile.locator('[data-testid="thread-status"]');
  await expect(thread).toHaveText("Open");
  await expect(tile.getByText(REVIEW_COMMENT, { exact: true })).toBeVisible();
  await expect(
    tile.locator("pre").filter({ hasText: "if (!trimmed) return null;" }),
  ).toBeVisible();
  await expect(tile.locator('[data-testid="resolve"]')).toBeVisible();
  await thread.scrollIntoViewIfNeeded();
  await demo.settled(thread);
});
