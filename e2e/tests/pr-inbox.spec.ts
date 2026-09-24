import { test, expect } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: { projects: [
        { name: "ADO repo", directory: "/demo/ado", git_remote: "https://dev.azure.com/o/p/_git/r" },
        { name: "Local repo", directory: "/demo/local" },
      ] },
    });
  });
  await page.goto("/");
});

test("repo opt-in, background arrival, read/unread, browser-open action and disable", async ({ page }) => {
  test.setTimeout(45_000);
  await page.getByTestId("repo-manager-button").click();
  const option = page.getByRole("checkbox", { name: "Notify me of new PR review assignments" });
  await expect(option).not.toBeChecked();
  await option.check();
  await expect(option).toBeChecked();
  await page.getByTestId("repo-manager-close").click();

  // Arrives while the inbox is closed and there are no loaded workstreams.
  await page.evaluate(async () => {
    const backend = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__;
    const repo = (await backend.listProjects()).find((p) => p.name === "ADO repo")!;
    backend.seedPrInboxItems([{
      id: "review-42", project_id: repo.id, repo_name: repo.name, pr_id: 42,
      title: "Review the race fix", author: "Dev", is_read: false,
      url: "https://dev.azure.com/o/p/_git/r/pullrequest/42", discovered_at: new Date().toISOString(),
    }]);
  });
  await expect(page.getByTestId("pr-inbox-unread")).toHaveText("1", { timeout: 10_000 });
  await page.getByTestId("pr-inbox-button").click();
  const notification = page.getByTestId("pr-notification-review-42");
  await expect(notification).toHaveAttribute("data-read", "false");
  await notification.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(notification).toHaveAttribute("data-read", "true");
  await expect(page.getByTestId("pr-inbox-unread")).toHaveCount(0);
  await notification.getByRole("button", { name: "Mark unread" }).click();
  await expect(page.getByTestId("pr-inbox-unread")).toHaveText("1");
  // The browser build's opener is a no-op; the unit test verifies the exact ADO URL.
  await notification.getByRole("button", { name: "#42 Review the race fix" }).click();
  await expect(notification).toHaveAttribute("data-read", "true");
  await page.getByRole("button", { name: "Close inbox" }).click();
  await page.getByTestId("repo-manager-button").click();
  await expect(option).toBeChecked();
  await option.uncheck();
  await expect(option).not.toBeChecked();
  await page.getByTestId("repo-manager-panel").getByRole("button", { name: /Local repo/ }).click();
  await expect(option).toBeDisabled();
  await page.getByTestId("repo-manager-close").click();
  await page.getByTestId("pr-inbox-button").click();
  await expect(notification).toHaveAttribute("data-read", "true");
  await expect(page.getByText("Notifications off")).toBeVisible();
});

test("connection failures are visible in the inbox and sidebar, not an empty success", async ({ page }) => {
  await page.getByTestId("repo-manager-button").click();
  await page.getByRole("checkbox").check();
  await page.getByTestId("repo-manager-close").click();
  await page.evaluate(async () => {
    const backend = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__;
    const read = backend.getPrInbox.bind(backend);
    backend.getPrInbox = async () => {
      const snapshot = await read();
      snapshot.repos[0].error = "ADO access denied. Run az login.";
      return snapshot;
    };
  });
  await expect(page.getByLabel("Inbox connection error")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("pr-inbox-button").click();
  await expect(page.getByRole("alert")).toHaveText("ADO access denied. Run az login.");
});
