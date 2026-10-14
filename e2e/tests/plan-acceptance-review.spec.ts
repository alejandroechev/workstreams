/**
 * E2E for the acceptance Review mode in the Plan tile (ADR 037).
 *
 * The acceptance file, its storyboard assets and the validation folders live in
 * an in-page store behind read_text_file / write_text_file (compare-and-swap) /
 * read_file_base64 / list_directory, so each test reads exactly what the view
 * wrote. The acceptance tests themselves are seeded into the memory backend so
 * the tab is shown.
 */
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const DIR = "/x/alpha";
const PATH = `${DIR}/acceptance.md`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const wire = (label: string) =>
  `<html><body style="background:#11111b;color:#cdd6f4"><div id="out">${label}</div></body></html>`;

const HOSTILE = `<!-- <head> fake </head> --><html><body>
<div id="out">static</div><img id="outside" src="../../secret.png">
<script>
document.getElementById("out").textContent = "script ran";
fetch("https://example.com/").then(() => { document.body.dataset.fetch = "ok"; }, () => { document.body.dataset.fetch = "blocked"; });
try { document.body.dataset.parent = String(window.parent.document.title); } catch (e) { document.body.dataset.parent = "blocked"; }
try { top.location = "https://example.com/"; } catch (e) {}
setTimeout(() => { location.href = "https://example.com/self"; }, 2000);
</script></body></html>`;

const FILE = (status: string) => `---
feature: alpha
status: ${status}
---

# Alpha — Acceptance Tests

## AT-1 — Saving shows a toast
**Validates:** US-1
**Automation:** agent

**Given** an open form
**When** you press Save
**Then** a toast says Saved

**Frame:** acceptance-assets/AT-1/given.html "The form" (given)
**Frame:** acceptance-assets/AT-1/when.png "Pressing Save" (when)
**Frame:** acceptance-assets/AT-1/when2.html "Save is busy" (when)
**Frame:** acceptance-assets/AT-1/then.html "The toast" (then)

**Verify (human):** Press Save.

**Verify (agent):** Drive it.
**Passes when:** a toast reads Saved.

---

## AT-2 — Already fine
**Validates:** US-2
**Automation:** agent
**Review:** ok

**Given** a
**When** b
**Then** c

**Passes when:** c.

---

## AT-3 — The CLI prints a version
**Validates:** US-3
**Automation:** agent

**Given** the CLI
**When** you run it
**Then** a version

**Passes when:** stdout has the version.

---

## AT-4 — Needs work
**Validates:** US-4
**Automation:** agent-partial
**Review:** change: say which list

**Given** a list
**When** you sort
**Then** it is sorted

**Passes when:** sorted.

---

## AT-5 — Sandboxed
**Validates:** NFR-1
**Automation:** agent

**Given** a hostile frame
**When** you open it
**Then** nothing escapes

**Frame:** acceptance-assets/AT-5/hostile.html "Hostile" (then)

**Passes when:** contained.

## Coverage
| Story | Tests |
|---|---|
| US-1 | AT-1 |
`;

type Fs = { files: Record<string, string>; versions: Record<string, number>; b64: Record<string, string>; dirs: Record<string, string[]> };

async function configure(page: Page, acceptance: string, dirs: Record<string, string[]> = {}) {
  await page.addInitScript(({ acceptance, path, dir, png, wires, hostile, dirs }) => {
    const fs: Fs = {
      files: { [path]: acceptance, ...wires, [`${dir}/acceptance-assets/AT-5/hostile.html`]: hostile },
      versions: {},
      b64: { [`${dir}/acceptance-assets/AT-1/when.png`]: png, [`${dir}/validation/r2/AT-1-1.png`]: png, [`${dir}/validation/r2/AT-1-4.png`]: png, "/x/secret.png": png },
      dirs,
    };
    (window as unknown as { __ACC_FS__: Fs }).__ACC_FS__ = fs;
    (window as unknown as { __WS_DEMO_SEED__?: unknown }).__WS_DEMO_SEED__ = {
      projects: [{ name: "Demo", directory: "/repos/demo" }],
      workstreams: [{ name: "Plan demo", directory: "/repos/demo", project: "Demo",
        tiles: [{ type: "copilot_session", title: "Plan demo", config: { pinned: true, copilot_session_id: "e2e-session" } }] }],
    };
    const handlers: Record<string, (args: never) => unknown> = {
      get_setting: () => null, set_setting: () => null, spawn_terminal: () => null, spawn_copilot_session: () => null,
      read_session_file: () => "# plan\n", list_session_features: () => ({ features: [], currentPlanId: null }),
      watch_session_features: () => null, unwatch_session_features: () => null, get_copilot_sessions: () => [],
      canonicalize_path: ({ path }: { path: string }) => path, watch_file_changes: () => null, unwatch_file_changes: () => null,
      read_text_file: ({ path }: { path: string }) => {
        const content = fs.files[path];
        if (content === undefined) throw new Error(`NotFound: ${path}`);
        return { content, hash_hex: String(fs.versions[path] ?? 0), mtime_unix_ms: 1, line_ending: "lf",
          has_trailing_newline: content.endsWith("\n"), sniffed_binary: false, size_bytes: content.length };
      },
      write_text_file: ({ args }: { args: { path: string; content: string; expected_hash_hex: string | null } }) => {
        const current = String(fs.versions[args.path] ?? 0);
        if (args.expected_hash_hex !== null && args.expected_hash_hex !== current) throw JSON.stringify({ kind: "ExternalModified", current_hash_hex: current });
        fs.files[args.path] = args.content;
        fs.versions[args.path] = (fs.versions[args.path] ?? 0) + 1;
        return { mtime_unix_ms: 1, hash_hex: String(fs.versions[args.path]) };
      },
      read_file_base64: ({ path }: { path: string }) => {
        if (!(path in fs.b64)) throw new Error(`NotFound: ${path}`);
        return fs.b64[path];
      },
      list_directory: ({ path }: { path: string }) => {
        if (!(path in fs.dirs)) throw new Error(`NotFound: ${path}`);
        return fs.dirs[path].map((name) => ({ name, is_dir: !name.includes("."), modified_epoch: 0, size: 0 }));
      },
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
  }, {
    acceptance, path: PATH, dir: DIR, png: PNG, hostile: HOSTILE, dirs,
    wires: {
      [`${DIR}/acceptance-assets/AT-1/given.html`]: wire("the form"),
      [`${DIR}/acceptance-assets/AT-1/when2.html`]: wire("busy"),
      [`${DIR}/acceptance-assets/AT-1/then.html`]: wire("the toast"),
    },
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    const backend = (window as unknown as { __WS_BACKEND__: { seedSessionFeatures: (id: string, p: unknown) => void; seedAcceptanceTests: (t: unknown[]) => void } }).__WS_BACKEND__;
    backend.seedSessionFeatures("e2e-session", {
      features: [{ name: "alpha", hasGrillMe: true, hasPlan: true, grillMePath: "/x/alpha/grill-me.md", planPath: "/x/alpha/plan.md",
        planId: "alpha-plan", planTitle: "Alpha", planStatus: "active", planCreatedAt: "2026-09-01T10:00:00.000Z",
        derivedStatus: "active", todosTotal: 1, todosDone: 0, todosInProgress: 0, todosBlocked: 0 }],
      currentPlanId: "alpha-plan",
    });
    backend.seedAcceptanceTests([{ id: "alpha-plan-AT-1", plan_id: "alpha-plan", at_id: "AT-1", title: "Saving shows a toast",
      validates: "US-1", automation: "agent", status: "not_run", last_run_at: null, evidence: null, notes: null }]);
  });
  await page.locator('[data-testid="workstream-item"]').first().click();
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-plan"]').click();
  await page.locator('[data-testid="plan-tab-acceptance"]').click();
}

const fileText = (page: Page) => page.evaluate((p) => (window as unknown as { __ACC_FS__: Fs }).__ACC_FS__.files[p], PATH);
const card = (page: Page) => page.locator('[data-testid="acceptance-card"]');
const markers = (page: Page) => page.locator('[data-testid="acceptance-marker"]');

test.describe("acceptance Review mode", () => {
  test("AT-1: the Acceptance tab opens in Review mode, with List one click away", async ({ page }) => {
    await configure(page, FILE("draft"));
    await expect(page.locator('[data-testid="acceptance-review-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="acceptance-mode-selector"] button')).toHaveText(["Review", "List"]);
    await expect(page.locator('[data-testid="acceptance-mode-review"]')).toHaveAttribute("aria-checked", "true");
    await page.locator('[data-testid="acceptance-mode-list"]').click();
    await expect(page.locator('[data-testid="acceptance-test-AT-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="acceptance-set-AT-1-pass"]')).toBeVisible();
  });

  test("AT-2: one test per screen in file order, with a strip and a filter by mark", async ({ page }) => {
    await configure(page, FILE("draft"));
    await expect(card(page)).toHaveCount(1);
    await expect(card(page)).toHaveAttribute("data-id", "AT-1");
    for (const part of ["Saving shows a toast", "US-1", "an open form", "you press Save", "a toast says Saved", "a toast reads Saved.", "Press Save.", "Drive it."]) {
      await expect(card(page)).toContainText(part);
    }
    await page.locator('[data-testid="acceptance-review-view"]').focus();
    await page.keyboard.press("ArrowRight");
    await expect(card(page)).toHaveAttribute("data-id", "AT-2");
    await page.keyboard.press("Enter");
    await expect(card(page)).toHaveAttribute("data-id", "AT-3");
    await page.keyboard.press("ArrowLeft");
    await expect(card(page)).toHaveAttribute("data-id", "AT-2");
    await page.locator('[data-testid="acceptance-next"]').click();
    await expect(card(page)).toHaveAttribute("data-id", "AT-3");
    expect(await markers(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-mark")))).toEqual(["unmarked", "ok", "unmarked", "change", "unmarked"]);
    await markers(page).nth(3).click();
    await expect(card(page)).toHaveAttribute("data-id", "AT-4");
    await page.locator('[data-testid="acceptance-filter"]').selectOption("unmarked");
    expect(await markers(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).toEqual(["AT-1", "AT-3", "AT-5"]);
  });

  test("AT-3: marks are written into their own test only, and nothing goes to the session", async ({ page }) => {
    const original = FILE("draft");
    await configure(page, original);
    await page.locator('[data-testid="acceptance-mark-ok"]').click();
    await expect.poll(() => fileText(page)).toContain("**Automation:** agent\n**Review:** ok\n\n**Given** an open form");
    await markers(page).nth(2).click();
    await page.locator('[data-testid="acceptance-mark-change"]').click();
    await page.locator('[data-testid="acceptance-change-note"]').fill("also cover the empty state");
    await page.locator('[data-testid="acceptance-change-save"]').click();
    await markers(page).first().click();
    await page.locator('[data-testid="acceptance-mark-change"]').click();
    await page.locator('[data-testid="acceptance-change-note"]').fill("too vague");
    await page.locator('[data-testid="acceptance-change-save"]').click();
    await page.locator('[data-testid="acceptance-missing-note"]').fill("nothing checks undo");
    await page.locator('[data-testid="acceptance-missing-add"]').click();
    await expect.poll(() => fileText(page)).toContain("- nothing checks undo");
    const expected = original
      .replace("**Automation:** agent\n\n**Given** an open form", "**Automation:** agent\n**Review:** change: too vague\n\n**Given** an open form")
      .replace("**Automation:** agent\n\n**Given** the CLI", "**Automation:** agent\n**Review:** change: also cover the empty state\n\n**Given** the CLI")
      .replace("## Coverage", "## Missing tests (review)\n- nothing checks undo\n\n## Coverage");
    expect(await fileText(page)).toBe(expected);
    await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
    const commands = await page.evaluate(() => (window as unknown as { __WS_INVOKE_LOG__: { cmd: string }[] }).__WS_INVOKE_LOG__.map((c) => c.cmd));
    expect(commands).not.toContain("write_to_pty");
  });

  test("AT-6, AT-9: a storyboard filmstrip with real screenshots beside its mockups, read-only", async ({ page }) => {
    await configure(page, FILE("approved"), { [`${DIR}/validation`]: ["r1", "r2"], [`${DIR}/validation/r1`]: [], [`${DIR}/validation/r2`]: ["AT-1-1.png", "AT-1-4.png"] });
    const frames = page.locator('[data-testid="acceptance-frame"]');
    await expect(frames).toHaveCount(4);
    expect(await frames.evaluateAll((els) => els.map((e) => e.getAttribute("data-step")))).toEqual(["given", "when", "when", "then"]);
    await expect(frames.nth(0)).toContainText("The form");
    await expect(frames.nth(3)).toContainText("The toast");
    await expect(frames.nth(1).locator("img").first()).toHaveAttribute("src", `data:image/png;base64,${PNG}`);
    await expect(page.frameLocator('[data-testid="acceptance-frame"] >> nth=0 >> iframe').locator("#out")).toHaveText("the form");
    // Screenshots from the latest round sit beside frames 1 and 4 only.
    await expect(frames.nth(0).locator('[data-testid="acceptance-actual"]')).toBeVisible();
    await expect(frames.nth(0)).toContainText("Actual — round 2");
    await expect(frames.nth(0)).toContainText("Expected");
    await expect(frames.nth(1).locator('[data-testid="acceptance-actual"]')).toHaveCount(0);
    await expect(frames.nth(3).locator('[data-testid="acceptance-actual"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /^(pass|fail|accept)\b/i })).toHaveCount(0);
    await frames.nth(2).locator('[data-testid="acceptance-frame-enlarge"]').click();
    await expect(page.locator('[data-testid="acceptance-frame-large"]')).toHaveAttribute("data-index", "2");
    await expect(page.locator('[data-testid="acceptance-frame-large"]')).toContainText("Save is busy");
  });

  test("AT-8 (UI half): Show me this writes a request into the test", async ({ page }) => {
    await configure(page, FILE("draft"));
    await markers(page).nth(2).click();
    await page.locator('[data-testid="acceptance-request-visual"]').click();
    await page.locator('[data-testid="acceptance-request-note"]').fill("the error state");
    await page.locator('[data-testid="acceptance-request-submit"]').click();
    await expect.poll(() => fileText(page)).toContain("**Visual requested:** the error state\n\n**Passes when:** stdout has the version.");
    await expect(page.locator('[data-testid="acceptance-visual-requested"]')).toContainText("the error state");
  });

  test("AT-11: an approved file is never written by the view", async ({ page }) => {
    const approved = FILE("approved");
    await configure(page, approved);
    await expect(page.locator('[data-testid="acceptance-status"]')).toContainText("Approved");
    for (const id of ["acceptance-mark-ok", "acceptance-mark-change", "acceptance-mark-clear", "acceptance-request-visual", "acceptance-missing-add", "acceptance-missing-note"]) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeDisabled();
    }
    await page.locator('[data-testid="acceptance-mark-ok"]').click({ force: true });
    await page.locator('[data-testid="acceptance-review-view"]').focus();
    for (const key of ["ArrowRight", "Enter", "ArrowLeft"]) await page.keyboard.press(key);
    await page.waitForTimeout(500);
    expect(await fileText(page)).toBe(approved);
    const writes = await page.evaluate(() => (window as unknown as { __WS_INVOKE_LOG__: { cmd: string }[] }).__WS_INVOKE_LOG__.filter((c) => c.cmd === "write_text_file").length);
    expect(writes).toBe(0);
  });

  test("AT-12: an older acceptance file opens as is", async ({ page }) => {
    const old = readFileSync(new URL("../../src/domain/acceptance/__tests__/fixtures/old-format.md", import.meta.url), "utf8");
    await configure(page, old);
    await expect(markers(page)).toHaveCount(15);
    await expect(page.locator('[data-testid="acceptance-storyboard"]')).toHaveCount(0);
    await expect(card(page)).toContainText("a normal Workstreams build");
    await expect(card(page)).toContainText("the Plan item is in the add-tile menu");
    await expect(page.locator('[data-testid="acceptance-request-visual"]')).toBeDisabled();
  });

  test("AT-13: mockup frames are sandboxed", async ({ page }) => {
    test.setTimeout(40_000);
    const outside = (u: string) => u.includes("example.com") || u.includes("secret.png");
    const reached: string[] = [];
    page.on("response", (r) => { if (outside(r.url())) reached.push(r.url()); });
    await page.context().route(/example\.com/, (route) => { reached.push(route.request().url()); return route.fulfill({ body: "<p id=pwned>remote</p>", contentType: "text/html" }); });
    await configure(page, FILE("draft"));
    const appUrl = page.url();
    await markers(page).nth(4).click();
    const frame = page.frameLocator('[data-testid="acceptance-frame"] iframe');
    await expect(frame.locator("#out")).toHaveText("script ran");
    await expect(frame.locator("body")).toHaveAttribute("data-fetch", "blocked");
    await expect(frame.locator("body")).toHaveAttribute("data-parent", "blocked");
    expect(await frame.locator("#outside").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(0);
    await page.waitForTimeout(3000);
    expect(page.url()).toBe(appUrl);
    await expect(frame.locator("#pwned")).toHaveCount(0);
    expect(reached).toEqual([]);
  });
});
