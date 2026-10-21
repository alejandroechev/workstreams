/**
 * Companion conversations, laptop side, in the real app: the spec plays the
 * paired phone through the in-memory hub (the VITE_E2E seam in main.tsx). It
 * messages existing session tiles and reads what the laptop publishes, which
 * terminals it stopped and how it resumed them.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const SECRET: string = JSON.parse(
  readFileSync(new URL("../../src/companion/protocol/fixtures.json", import.meta.url), "utf8"),
).secret;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((secret) => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: {
        projects: [{ name: "Repo", directory: "/repo", copilot_command: "repo-copilot --yolo" }],
        workstreams: [
          { name: "Alpha", directory: "/repo/alpha", project: "Repo" },
          {
            name: "Beta",
            directory: "/beta",
            tiles: [
              { type: "copilot_session", title: "Beta/1", config: { copilot_session_id: "s-beta-1", session_name: "Fix the lanes", cwd: "/beta" } },
              { type: "copilot_session", title: "Beta/2", config: { cwd: "/beta" } },
            ],
          },
        ],
      },
      __WS_COMPANION_E2E__: {
        "companion.enabled": "1",
        "companion.doc_url": "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh",
        "companion.secret": secret,
        "companion.folder_root": "/phone",
      },
    });
  }, SECRET);
  await page.goto("/");
  await expect(page.getByTestId("workstream-item").first()).toBeVisible();
});

type Tile = { tileId: string; workstreamId: string; title: string; summary: string | null; linked: boolean; linkRevision: string | null; origin: string };
type PhoneWindow = {
  __WS_COMPANION_PHONE__: {
    read(): {
      laptop: { tiles?: Tile[] };
      requests: Record<string, { outcome?: { status: string; error?: string } }>;
      sessions?: Record<string, { messages: Array<{ kind: string; text: string }> }>;
    };
    change(fn: (d: { requests: Record<string, unknown> }) => void): void;
  };
  __WS_COMPANION_SIGN__: (secret: string, request: unknown) => Promise<string>;
  __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }>;
  __WS_PTY_IGNORES_CTRL_C__?: string[];
  __WS_BACKEND__: {
    listWorkstreams(): Promise<Array<{ id: string; name: string }>>;
    listTiles(id: string): Promise<Array<{ id: string; tile_type: string }>>;
    companionSendForTests(tileId: string, kind: "progress" | "result", text: string): void;
  };
};

const phone = (page: Page) => page.evaluate(() => (window as unknown as PhoneWindow).__WS_COMPANION_PHONE__.read());

async function send(page: Page, request: { id: string; kind: string; args: Record<string, string> }) {
  await page.evaluate(async ({ request, secret }) => {
    const w = window as unknown as PhoneWindow;
    const full = { ...request, createdAt: Date.now() };
    const signature = await w.__WS_COMPANION_SIGN__(secret, full);
    w.__WS_COMPANION_PHONE__.change((d) => { d.requests[full.id] = { ...full, signature }; });
  }, { request, secret: SECRET });
}

async function outcome(page: Page, id: string) {
  await expect.poll(async () => (await phone(page)).requests[id]?.outcome?.status ?? "pending", { timeout: 15_000 })
    .not.toMatch(/pending|running/);
  return (await phone(page)).requests[id].outcome!;
}

const log = (page: Page, tileId: string) =>
  page.evaluate((id) => ((window as unknown as PhoneWindow).__WS_INVOKE_LOG__ ?? [])
    .filter((e) => e.args.tileId === id && ["spawn_copilot_session", "write_to_pty", "close_terminal"].includes(e.cmd))
    .map((e) => (e.cmd === "spawn_copilot_session" ? `spawn:${e.args.resumeSessionId}:${e.args.initialPrompt}` : e.cmd === "write_to_pty" ? `write:${JSON.stringify(e.args.data)}` : e.cmd)), tileId);

const workstreamId = async (page: Page, name: string) =>
  (await page.evaluate(() => (window as unknown as PhoneWindow).__WS_BACKEND__.listWorkstreams())).find((w) => w.name === name)!.id;
const row = (page: Page, id: string) => page.locator(`[data-testid="workstream-item"][data-workstream-id="${id}"]`);

async function publishedTiles(page: Page) {
  await expect.poll(async () => (await phone(page)).laptop.tiles?.length ?? 0).toBe(2);
  const tiles = (await phone(page)).laptop.tiles!;
  return { linked: tiles.find((t) => t.title === "Beta/1")!, unlinked: tiles.find((t) => t.title === "Beta/2")! };
}

test("AT-1: publishes every Copilot tile, linked or not, without its session id", async ({ page }) => {
  const beta = await workstreamId(page, "Beta");
  const { linked, unlinked } = await publishedTiles(page);
  expect(linked).toMatchObject({ workstreamId: beta, summary: "Fix the lanes", linked: true, origin: "laptop" });
  expect(linked.linkRevision).toMatch(/^[0-9a-f]{16}$/);
  expect(unlinked).toMatchObject({ workstreamId: beta, linked: false, linkRevision: null, summary: null, origin: "laptop" });
  expect(JSON.stringify((await phone(page)).laptop.tiles)).not.toContain("s-beta-1");
});

test("AT-2/AT-7/AT-11: a message resumes a laptop session in its own tile, in the background, and it can reply", async ({ page }) => {
  const alpha = await workstreamId(page, "Alpha");
  await row(page, alpha).click();
  await expect(row(page, alpha)).toHaveAttribute("data-active", "true");
  const { linked } = await publishedTiles(page);
  const beta = linked.workstreamId;
  const tilesBefore = (await page.evaluate((id) => (window as unknown as PhoneWindow).__WS_BACKEND__.listTiles(id), beta)).length;

  await send(page, { id: "m1", kind: "message", args: { workstreamId: beta, tileId: linked.tileId, linkRevision: linked.linkRevision!, prompt: "Use the palette\nfor every lane" } });
  expect(await outcome(page, "m1")).toMatchObject({ status: "done" });

  // Mounted in the background: the one spawn is the resume with the message, nothing to stop first.
  expect(await log(page, linked.tileId)).toEqual([`spawn:s-beta-1:Use the palette\nfor every lane`]);
  await expect(row(page, alpha)).toHaveAttribute("data-active", "true");
  await expect(row(page, beta).getByTestId("ws-indicator-stopped")).toHaveCount(0);
  expect((await page.evaluate((id) => (window as unknown as PhoneWindow).__WS_BACKEND__.listTiles(id), beta)).length).toBe(tilesBefore);
  await expect(page.locator(`[data-last-notice]`).first()).toHaveAttribute("data-last-notice", "Resumed from phone: Use the palette");

  // It is now a phone session: the thread holds the prompt, and the agent can reply.
  await expect.poll(async () => (await phone(page)).laptop.tiles?.find((t) => t.tileId === linked.tileId)?.origin).toBe("phone");
  // What the agent's `companion.send` does, then the event it raises.
  await page.evaluate((id) => {
    const w = window as unknown as PhoneWindow & { __WS_EMIT__: (e: string, p: unknown) => void };
    w.__WS_BACKEND__.companionSendForTests(id, "result", "Done: lanes recoloured");
    w.__WS_EMIT__("state-changed", { entity: "companion_message", id, action: "added" });
  }, linked.tileId);
  await expect.poll(async () => (await phone(page)).sessions?.[linked.tileId]?.messages.map((m) => `${m.kind}:${m.text}`))
    .toEqual(["prompt:Use the palette\nfor every lane", "result:Done: lanes recoloured"]);
});

test("AT-2/AT-4/AT-5: a running session is stopped and resumed for each message, in order", async ({ page }) => {
  const { linked } = await publishedTiles(page);
  const beta = linked.workstreamId;
  await send(page, { id: "load", kind: "load", args: { workstreamId: beta } });
  await outcome(page, "load");
  await expect.poll(() => log(page, linked.tileId)).toEqual(["spawn:s-beta-1:null"]);

  const args = { workstreamId: beta, tileId: linked.tileId, linkRevision: linked.linkRevision! };
  await send(page, { id: "m1", kind: "message", args: { ...args, prompt: "First" } });
  await send(page, { id: "m2", kind: "message", args: { ...args, prompt: "Second" } });
  expect(await outcome(page, "m1")).toMatchObject({ status: "done" });
  expect(await outcome(page, "m2")).toMatchObject({ status: "done" });
  expect(await log(page, linked.tileId)).toEqual([
    "spawn:s-beta-1:null",
    'write:"\\u0003"', 'write:"\\u0003"', "close_terminal", "spawn:s-beta-1:First",
    'write:"\\u0003"', 'write:"\\u0003"', "close_terminal", "spawn:s-beta-1:Second",
  ]);
  await expect.poll(async () => (await phone(page)).sessions?.[linked.tileId]?.messages.map((m) => m.text)).toEqual(["First", "Second"]);
});

test("AT-3: a session that ignores Ctrl+C is killed after the grace period, then resumed", async ({ page }) => {
  test.setTimeout(40_000);
  const { linked } = await publishedTiles(page);
  await send(page, { id: "load", kind: "load", args: { workstreamId: linked.workstreamId } });
  await outcome(page, "load");
  await page.evaluate((id) => { (window as unknown as PhoneWindow).__WS_PTY_IGNORES_CTRL_C__ = [id]; }, linked.tileId);
  const started = Date.now();
  await send(page, { id: "m1", kind: "message", args: { workstreamId: linked.workstreamId, tileId: linked.tileId, linkRevision: linked.linkRevision!, prompt: "Stuck?" } });
  expect(await outcome(page, "m1")).toMatchObject({ status: "done" });
  expect(Date.now() - started).toBeGreaterThan(4_500);
  expect((await log(page, linked.tileId)).slice(1)).toEqual(['write:"\\u0003"', 'write:"\\u0003"', "close_terminal", "spawn:s-beta-1:Stuck?"]);
});

test("AT-6: an unlinked tile, or one linked elsewhere since, is refused and left alone", async ({ page }) => {
  const { linked, unlinked } = await publishedTiles(page);
  const beta = linked.workstreamId;
  await send(page, { id: "u", kind: "message", args: { workstreamId: beta, tileId: unlinked.tileId, linkRevision: "0000000000000000", prompt: "Hi" } });
  expect(await outcome(page, "u")).toMatchObject({ status: "failed", error: expect.stringContaining("can't be resumed yet") });
  await send(page, { id: "stale", kind: "message", args: { workstreamId: beta, tileId: linked.tileId, linkRevision: "0000000000000000", prompt: "Hi" } });
  expect(await outcome(page, "stale")).toMatchObject({ status: "failed", error: expect.stringContaining("different Copilot session") });
  expect(await log(page, linked.tileId)).toEqual([]);
  expect(await log(page, unlinked.tileId)).toEqual([]);
  expect((await phone(page)).sessions ?? {}).toEqual({});
});

test("closing a workstream keeps publishing its current tiles, not the ones seen at startup", async ({ page }) => {
  const beta = await workstreamId(page, "Beta");
  await publishedTiles(page);
  await page.evaluate((id) => (window as unknown as PhoneWindow & { __WS_BACKEND__: { createTile(w: string, t: string, title: string, c: string): Promise<unknown> } })
    .__WS_BACKEND__.createTile(id, "copilot_session", "Beta/3", JSON.stringify({ copilot_session_id: "s-beta-3", cwd: "/beta" })), beta);
  await row(page, beta).click();
  await expect(row(page, beta)).toHaveAttribute("data-active", "true");
  await expect.poll(async () => (await phone(page)).laptop.tiles?.map((t) => t.title).sort()).toEqual(["Beta/1", "Beta/2", "Beta/3"]);

  await row(page, beta).hover();
  await row(page, beta).locator('[data-testid^="ws-actions-"]').click();
  await page.locator('[data-testid="action-close"]').click();
  await expect(row(page, beta)).toHaveAttribute("data-active", "false");
  // Give a stale republish the chance to happen, then check it didn't.
  await page.waitForTimeout(500);
  await expect.poll(async () => (await phone(page)).laptop.tiles?.map((t) => t.title).sort()).toEqual(["Beta/1", "Beta/2", "Beta/3"]);
});
