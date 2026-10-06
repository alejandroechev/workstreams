/**
 * Phone companion, laptop side, in the real app (ADR 033). The page talks to
 * an in-memory hub instead of the sync server (the VITE_E2E seam in main.tsx)
 * and the spec plays the paired phone: it writes signed requests into the
 * document and reads what the laptop publishes.
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
          // Saved sessions on a workstream that is not mounted at startup.
          { name: "Beta", directory: "/beta", tiles: [{ type: "copilot_session", title: "Beta/1" }, { type: "copilot_session", title: "Beta/2" }] },
          { name: "Gamma", directory: "/repo/gamma", project: "Repo" },
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

type PhoneWindow = {
  __WS_COMPANION_PHONE__: {
    read(): {
      laptop: { workstreams: Array<{ id: string; name: string; loaded: boolean; sessionCount: number }>; lastSeenAt: number | null };
      requests: Record<string, { outcome?: { status: string; error?: string; workstreamId?: string } }>;
      sessions?: Record<string, { title: string; workstreamName: string; requestId: string; messages: Array<{ kind: string; text: string }> }>;
    };
    change(fn: (d: { requests: Record<string, unknown> }) => void): void;
  };
  __WS_COMPANION_SIGN__: (secret: string, request: unknown) => Promise<string>;
  __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }>;
  __WS_BACKEND__: {
    listWorkstreams(): Promise<Array<{ id: string; name: string; directory: string | null; project_id: string | null }>>;
    listTiles(id: string): Promise<Array<{ id: string; tile_type: string }>>;
    companionListSessions(): Promise<Array<{ tileId: string; workstreamId: string; requestId: string; prompt: string }>>;
    companionSendForTests(tileId: string, kind: "progress" | "result", text: string): void;
  };
};

const phone = (page: Page) => page.evaluate(() => (window as unknown as PhoneWindow).__WS_COMPANION_PHONE__.read());

async function send(page: Page, request: { id: string; kind: string; args: Record<string, string> }, options: { secret?: string | null; ageMs?: number } = {}) {
  await page.evaluate(
    async ({ request, secret, ageMs }) => {
      const w = window as unknown as PhoneWindow;
      const full = { ...request, createdAt: Date.now() - ageMs };
      const signature = secret === null ? "" : await w.__WS_COMPANION_SIGN__(secret, full);
      w.__WS_COMPANION_PHONE__.change((d) => { d.requests[full.id] = { ...full, signature }; });
    },
    { request, secret: options.secret === undefined ? SECRET : options.secret, ageMs: options.ageMs ?? 0 },
  );
}

async function outcome(page: Page, id: string) {
  await expect.poll(async () => (await phone(page)).requests[id]?.outcome?.status ?? "pending", { timeout: 10_000 })
    .not.toMatch(/pending|running/);
  return (await phone(page)).requests[id].outcome!;
}

const workstreamId = async (page: Page, name: string) =>
  (await page.evaluate(() => (window as unknown as PhoneWindow).__WS_BACKEND__.listWorkstreams())).find((w) => w.name === name)!.id;
const row = (page: Page, id: string) => page.locator(`[data-testid="workstream-item"][data-workstream-id="${id}"]`);
const spawns = (page: Page) =>
  page.evaluate(() => ((window as unknown as PhoneWindow).__WS_INVOKE_LOG__ ?? []).filter((e) => e.cmd === "spawn_copilot_session").map((e) => e.args));

test("AT-3: publishes the non-archived workstreams in sidebar order, and presence", async ({ page }) => {
  await expect.poll(async () => (await phone(page)).laptop.workstreams.length).toBe(3);
  const sidebarIds = await page.getByTestId("workstream-item").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-workstream-id")));
  expect((await phone(page)).laptop.workstreams.map((w) => w.id)).toEqual(sidebarIds);
  expect((await phone(page)).laptop.lastSeenAt).not.toBeNull();
});

test("publishes saved session counts for workstreams that are not mounted", async ({ page }) => {
  const saved = await page.evaluate(async () => {
    const backend = (window as unknown as PhoneWindow).__WS_BACKEND__;
    const counts: Record<string, number> = {};
    for (const w of await backend.listWorkstreams()) {
      counts[w.id] = (await backend.listTiles(w.id)).filter((t) => t.tile_type === "copilot_session").length;
    }
    return counts;
  });
  expect(Object.values(saved)).toContain(2);
  await expect.poll(async () => Object.fromEntries((await phone(page)).laptop.workstreams.map((w) => [w.id, w.sessionCount]))).toEqual(saved);
});

test("AT-5: loads a workstream in the background without changing the one on screen", async ({ page }) => {
  const alpha = await workstreamId(page, "Alpha");
  const beta = await workstreamId(page, "Beta");
  await row(page, alpha).click();
  await expect(row(page, alpha)).toHaveAttribute("data-active", "true");
  await expect(row(page, beta).getByTestId("ws-indicator-stopped")).toBeVisible();

  await send(page, { id: "load-beta", kind: "load", args: { workstreamId: beta } });
  expect(await outcome(page, "load-beta")).toMatchObject({ status: "done" });
  await expect(row(page, beta).getByTestId("ws-indicator-stopped")).toHaveCount(0);
  await expect(row(page, alpha)).toHaveAttribute("data-active", "true");
  await expect.poll(async () => (await phone(page)).laptop.workstreams.find((w) => w.id === beta)?.loaded).toBe(true);
});

test("AT-8/AT-9: starts a session on the phone's prompt with the repo's own command", async ({ page }) => {
  const alpha = await workstreamId(page, "Alpha");
  const gamma = await workstreamId(page, "Gamma");
  await row(page, alpha).click();

  await send(page, { id: "s1", kind: "session", args: { workstreamId: gamma, prompt: "Line one\nLine two" } });
  expect(await outcome(page, "s1")).toMatchObject({ status: "done" });
  expect(await spawns(page)).toContainEqual(expect.objectContaining({
    cwd: "/repo/gamma",
    command: "repo-copilot --yolo",
    initialPrompt: "Line one\nLine two",
  }));
  // Gamma was not loaded: the same request loaded it, in the background.
  await expect(row(page, gamma).getByTestId("ws-indicator-stopped")).toHaveCount(0);
  await expect(row(page, alpha)).toHaveAttribute("data-active", "true");
});

test("AT-6/AT-7: creates a workstream in a fresh folder, with an agent only when given a prompt", async ({ page }) => {
  await send(page, { id: "c1", kind: "create", args: { name: "Phone idea" } });
  const plain = await outcome(page, "c1");
  expect(plain.status).toBe("done");
  await send(page, { id: "c2", kind: "create", args: { name: "Fix the docs", prompt: "List the files here" } });
  const withPrompt = await outcome(page, "c2");
  expect(withPrompt.status).toBe("done");

  const all = await page.evaluate(() => (window as unknown as PhoneWindow).__WS_BACKEND__.listWorkstreams());
  const idea = all.find((w) => w.id === plain.workstreamId)!;
  const docs = all.find((w) => w.id === withPrompt.workstreamId)!;
  expect(idea).toMatchObject({ name: "Phone idea", directory: "/phone/phone-idea", project_id: null });
  expect(docs).toMatchObject({ name: "Fix the docs", directory: "/phone/fix-the-docs", project_id: null });
  await expect(row(page, idea.id)).toBeVisible();

  const started = await spawns(page);
  expect(started.filter((s) => s.cwd === "/phone/phone-idea")).toEqual([]);
  expect(started.filter((s) => s.cwd === "/phone/fix-the-docs")).toEqual([
    expect.objectContaining({ command: "agency copilot --yolo", initialPrompt: "List the files here" }),
  ]);
});

test("AT-13: unsigned and stale requests are refused and do nothing", async ({ page }) => {
  await send(page, { id: "u", kind: "create", args: { name: "Unsigned" } }, { secret: null });
  await send(page, { id: "old", kind: "create", args: { name: "Stale" } }, { ageMs: 10 * 60_000 });
  expect(await outcome(page, "u")).toMatchObject({ status: "failed", error: expect.any(String) });
  expect(await outcome(page, "old")).toMatchObject({ status: "failed", error: expect.stringMatching(/too old/i) });
  const names = (await page.evaluate(() => (window as unknown as PhoneWindow).__WS_BACKEND__.listWorkstreams())).map((w) => w.name);
  expect(names).not.toContain("Unsigned");
  expect(names).not.toContain("Stale");
});

test("AT-2/AT-4: a phone session is recorded, published, and its agent's messages reach the document", async ({ page }) => {
  const gamma = await workstreamId(page, "Gamma");
  await send(page, { id: "ask", kind: "session", args: { workstreamId: gamma, prompt: "Summarise the open PRs\nThen list risks" } });
  expect(await outcome(page, "ask")).toMatchObject({ status: "done" });

  const recorded = await page.evaluate(() => (window as unknown as PhoneWindow).__WS_BACKEND__.companionListSessions());
  expect(recorded).toHaveLength(1);
  const tileId = recorded[0].tileId;
  const tiles = await page.evaluate((id) => (window as unknown as PhoneWindow).__WS_BACKEND__.listTiles(id), gamma);
  expect(tiles.filter((t) => t.tile_type === "copilot_session").map((t) => t.id)).toContain(tileId);
  expect(recorded[0]).toMatchObject({ workstreamId: gamma, requestId: "ask" });

  await expect.poll(async () => (await phone(page)).sessions?.[tileId]).toMatchObject({
    title: "Summarise the open PRs", workstreamName: "Gamma", requestId: "ask", messages: [],
  });

  // What the agent's `companion.send` does, then the event it raises.
  await page.evaluate((id) => {
    const w = window as unknown as PhoneWindow & { __WS_EMIT__: (e: string, p: unknown) => void };
    w.__WS_BACKEND__.companionSendForTests(id, "progress", "Looking…");
    w.__WS_BACKEND__.companionSendForTests(id, "result", "# PRs\n- one");
    w.__WS_EMIT__("state-changed", { entity: "companion_message", id, action: "added" });
  }, tileId);
  await expect.poll(async () => (await phone(page)).sessions?.[tileId]?.messages.map((m) => [m.kind, m.text])).toEqual([
    ["progress", "Looking…"],
    ["result", "# PRs\n- one"],
  ]);
});

test("AT-3: sessions opened on the laptop are never recorded as phone sessions", async ({ page }) => {
  const alpha = await workstreamId(page, "Alpha");
  await row(page, alpha).click();
  await expect(row(page, alpha)).toHaveAttribute("data-active", "true");
  // A Copilot session that did not come from the phone (as an agent or the
  // laptop UI creates one), announced the way the app learns of new tiles.
  await page.evaluate(async (id) => {
    const w = window as unknown as PhoneWindow & { __WS_EMIT__: (e: string, p: unknown) => void };
    const tile = await (w.__WS_BACKEND__ as unknown as { createTile(ws: string, t: string, title: string, cfg: string): Promise<unknown> })
      .createTile(id, "copilot_session", "Alpha/1", "{}");
    w.__WS_EMIT__("tile-created", tile);
  }, alpha);
  await expect.poll(async () => (await page.evaluate((id) => (window as unknown as PhoneWindow).__WS_BACKEND__.listTiles(id), alpha))
    .filter((t) => t.tile_type === "copilot_session").length).toBeGreaterThan(0);
  await send(page, { id: "load-only", kind: "load", args: { workstreamId: await workstreamId(page, "Beta") } });
  expect(await outcome(page, "load-only")).toMatchObject({ status: "done" });
  expect(await page.evaluate(() => (window as unknown as PhoneWindow).__WS_BACKEND__.companionListSessions())).toEqual([]);
  expect((await phone(page)).sessions ?? {}).toEqual({});
});
