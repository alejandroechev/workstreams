/**
 * Agent messages in the Inbox (ADR 041): the in-memory backend plays the
 * agent's `inbox.message`. Covers AT-1 to AT-5 of
 * files/features/agent-inbox-messages/acceptance.md; AT-6 to AT-8 are native
 * tests (inbox_messages, inbox_retention, agent_registry).
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";

const BODY = "## Results\n\n- p50: 12 → 9 ms\n- p95: 38 → 21 ms\n- p99: 61 → 40 ms\n\nFull report in `bench/out.md`";

async function start(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: {
        workstreams: [
          { name: "Read chunks", directory: "/demo/read", loaded: true, tiles: [{ type: "terminal", title: "Shell" }] },
          { name: "Bench", directory: "/demo/bench", tiles: [{ type: "terminal", title: "Shell" }, { type: "copilot_session", title: "Bench session" }] },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByTestId("workstream-item").filter({ hasText: "Read chunks" }).click();
}

const backend = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

async function post(page: Page, wsName: string, level = "done", title = "Benchmarks finished", body = BODY) {
  const ws = (await backend<Array<{ id: string; name: string }>>(page, "listWorkstreams")).find((w) => w.name === wsName)!;
  const tile = (await backend<Array<{ id: string; tile_type: string }>>(page, "listTiles", ws.id)).find((t) => t.tile_type === "copilot_session")!;
  const message = await backend<{ id: string }>(page, "postAgentMessage", ws.id, tile.id, level, title, body);
  return { ws, tile, id: message.id };
}

const SNAPSHOT = { timeout: 12_000 };
const active = (page: Page) => page.locator('[data-testid="workstream-item"][data-active="true"]');
const badge = async (page: Page) => Number((await page.getByTestId("pr-inbox-button").innerText()).match(/\d+/)?.[0] ?? 0);

test("AT-1: an agent's message shows first in the Inbox, under its workstream", async ({ page }) => {
  await start(page);
  const before = await badge(page);
  const { ws, id } = await post(page, "Bench");
  await expect.poll(() => badge(page), SNAPSHOT).toBe(before + 1);
  await page.getByTestId("pr-inbox-button").click();
  const sections = page.locator('[data-testid^="inbox-section-"]');
  await expect(sections.first()).toHaveAttribute("data-testid", "inbox-section-agents");
  await expect(page.getByTestId(`agent-group-${ws.id}`)).toContainText("Bench");
  const row = page.getByTestId(`agent-message-${id}`);
  await expect(row).toContainText("Done");
  await expect(row).toContainText("Benchmarks finished");
  await expect(row.getByTestId("agent-message-preview-line")).toHaveText(["Results", "p50: 12 → 9 ms"]);
  await expect(page.getByTestId("pr-inbox-summary")).toContainText("1 unread");
  const notifications = await page.evaluate(() => (window.__WS_INVOKE_LOG__ ?? []).filter((e) => /notif/i.test(e.cmd)).length);
  expect(notifications).toBe(0);
});

test("AT-2: the full message can be read in place, without switching or marking it read", async ({ page }) => {
  await start(page);
  const { id } = await post(page, "Bench");
  await page.getByTestId("pr-inbox-button").click();
  await page.getByTestId(`agent-message-expand-${id}`).click(SNAPSHOT);
  const body = page.getByTestId(`agent-message-body-${id}`);
  await expect(body.getByRole("heading", { name: "Results" })).toBeVisible();
  await expect(body.getByRole("listitem")).toHaveCount(3);
  await expect(body.locator("code")).toContainText("bench/out.md");
  await expect(active(page)).toContainText("Read chunks");
  await expect(page.getByRole("dialog", { name: "Inbox" })).toBeVisible();
  expect((await backend<{ agent_messages: Array<{ is_read: boolean }> }>(page, "getPrInbox")).agent_messages[0].is_read).toBe(false);
  await page.getByTestId(`agent-message-expand-${id}`).click();
  await expect(body).toHaveCount(0);
});

test("AT-3: clicking a message goes to the session that sent it", async ({ page }) => {
  await start(page);
  const { ws, tile, id } = await post(page, "Bench");
  await page.getByTestId("pr-inbox-button").click();
  await page.getByTestId(`agent-message-open-${id}`).click(SNAPSHOT);
  await expect(page.getByRole("dialog", { name: "Inbox" })).toHaveCount(0);
  await expect(page.locator(`[data-testid="workstream-item"][data-workstream-id="${ws.id}"]`)).toHaveAttribute("data-active", "true");
  await expect(page.locator(`[data-tile-id="${tile.id}"]`)).toHaveAttribute("data-focused", "true");
  expect((await backend<{ agent_messages: Array<{ is_read: boolean }> }>(page, "getPrInbox")).agent_messages[0].is_read).toBe(true);
});

test("AT-4: a message from a deleted workstream stays but can't jump", async ({ page }) => {
  await start(page);
  const { ws, id } = await post(page, "Bench");
  await backend(page, "deleteWorkstream", ws.id);
  await page.getByTestId("pr-inbox-button").click();
  await expect(page.getByTestId(`agent-message-gone-${id}`)).toBeVisible(SNAPSHOT);
  await expect(page.getByTestId(`agent-group-${ws.id}`)).toContainText("Bench");
  await expect(page.getByTestId(`agent-message-gone-${id}`)).toContainText("no longer exists");
  await expect(page.getByTestId(`agent-message-open-${id}`)).toBeDisabled();
  await page.getByTestId(`agent-message-open-${id}`).click({ force: true });
  await expect(active(page)).toContainText("Read chunks");
});

test("AT-5: the Agents filter, and the long Inbox description is gone", async ({ page }) => {
  await start(page);
  await post(page, "Bench");
  await page.evaluate(async () => {
    const b = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__;
    b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 1, name: "CI" });
    const w = await b.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=1", "failures");
    b.finishPipelineRun(w.id, { id: 9, number: "9", result: "failed", finished_at: "2100-01-01T00:00:00Z" });
  });
  await page.getByTestId("pr-inbox-button").click();
  await expect(page.getByTestId("inbox-section-pipelines")).toBeVisible(SNAPSHOT);
  const dialog = page.getByRole("dialog", { name: "Inbox" });
  await expect(dialog).not.toContainText("ADO activity on the PRs each repo watches");
  await page.getByTestId("inbox-kind-agents").click();
  await expect(page.locator('[data-testid^="inbox-section-"]')).toHaveCount(1);
  await expect(page.getByTestId("inbox-section-agents")).toBeVisible();
  await expect(dialog).not.toContainText("ADO activity on the PRs each repo watches");
});
