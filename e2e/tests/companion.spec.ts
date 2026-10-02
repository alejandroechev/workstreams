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
          { name: "Beta", directory: "/beta" },
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
      laptop: { workstreams: Array<{ id: string; name: string; loaded: boolean }>; lastSeenAt: number | null };
      requests: Record<string, { outcome?: { status: string; error?: string; workstreamId?: string } }>;
    };
    change(fn: (d: { requests: Record<string, unknown> }) => void): void;
  };
  __WS_COMPANION_SIGN__: (secret: string, request: unknown) => Promise<string>;
  __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }>;
  __WS_BACKEND__: { listWorkstreams(): Promise<Array<{ id: string; name: string; directory: string | null; project_id: string | null }>> };
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
