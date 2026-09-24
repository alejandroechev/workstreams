// Windows CDP protocol. Seed only the runner's isolated dev DB, with polling off.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect } from "@playwright/test";

export async function run({ page, screenshot }) {
  const db = new Database(resolve(".dev/workstreams-dev.db"), { fileMustExist: true });
  db.pragma("foreign_keys = ON");
  const id = `inbox-visual-${randomUUID()}`;
  const url = "https://dev.azure.com/example/project/_git/repo/pullrequest/42";
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO projects(id,name,directory,git_remote,color,created_at,updated_at)
        VALUES (?,'Inbox visual fixture',?,'https://dev.azure.com/example/project/_git/repo','#89b4fa','t','t')`).run(id, id);
      db.prepare(`INSERT INTO pr_inbox_config(project_id,enabled,current_identity,current_source)
        VALUES (?,0,'visual','visual')`).run(id);
      db.prepare(`INSERT INTO pr_inbox_seen(id,project_id,source,identity,pr_id,title,author,url,notified,is_read,discovered_at)
        VALUES (?,?,'visual','visual',42,'Review the race fix','Fixture author',?,1,0,'2026-01-01T00:00:00Z')`).run(id,id,url);
    })();
    await page.reload();
    await page.getByTestId("repo-manager-button").click();
    await page.getByTestId("repo-manager-filter").selectOption("all");
    // Proves the page belongs to the seeded dev DB before changing any UI state.
    await expect(page.getByTestId(`repo-manager-row-${id}`)).toBeVisible();
    await page.getByTestId(`repo-manager-row-${id}`).click();
    await expect(page.getByRole("checkbox", { name: "Notify me of new PR review assignments" })).not.toBeChecked();
    await screenshot("repo-opt-in-off");
    await page.getByTestId("repo-manager-close").click();
    await page.getByTestId("pr-inbox-button").click();
    const item = page.getByTestId(`pr-notification-${id}`);
    await expect(item).toHaveAttribute("data-read", "false");
    await screenshot("unread-assignment");
    await item.getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(item).toHaveAttribute("data-read", "true");
    expect(db.prepare("SELECT is_read FROM pr_inbox_seen WHERE id=?").get(id).is_read).toBe(1);
    await item.getByRole("button", { name: "Mark unread" }).click();
    await expect(item).toHaveAttribute("data-read", "false");
    await screenshot("marked-unread");
    await page.getByRole("button", { name: "Close inbox" }).click();
  } finally {
    db.prepare("DELETE FROM projects WHERE id=?").run(id);
    db.close();
  }
}
