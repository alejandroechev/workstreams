/**
 * E2E for the grill Answer mode in the Plan tile (ADR 034).
 *
 * The grill file and its assets live in an in-page store behind the
 * `read_text_file` / `write_text_file` (compare-and-swap) / `read_file_base64`
 * invoke handlers, so each test can read exactly what the view wrote and play
 * the agent by changing the file underneath it. No feature flag is set: the
 * Plan tile is no longer gated.
 */
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const GRILL_PATH = "/x/alpha/grill-me.md";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const ROUND_1 = `# Grill-Me: alpha

> **Status:** Round 2 open — awaiting answers.

## A. Shape

### A1. Where it lives
**Importance:** High

- (a) laptop
- (b) phone

**Recommendation:** (a)

**Answer:** a

---

`;

const ROUND_2 = `## Round 2 — follow-ups

### A1. Layout
**Importance:** Low

How the pieces talk:

\`\`\`mermaid
flowchart LR
  Phone --> Server
\`\`\`

- (a) tabs
- (b) slides

**Visual:** grill-assets/A1/flow.png "Current flow"
**Visual:** grill-assets/A1/tabs.html "Tabs" (a)
**Visual:** grill-assets/A1/slides.html "Slides" (b)

**Recommendation:** (a) because tabs are simpler

**Answer:**

---

### A2. Sync
**Importance:** Medium

**Recommendation:** poll every two seconds

**Answer:** already answered

---

### A3. Storage
**Importance:** High

- (a) file
- (b) database
- (c) both

**Recommendation:** (a)

**Answer:**

---

### A4. Security
**Importance:** Blocking

**Recommendation:** sandbox everything

**Answer:**

---

### A5. Naming
**Importance:** Medium

**Recommendation:** keep the name

**Answer:** fine

---

## When you're done
Tell me **"review"**.
`;

const GRILL = ROUND_1 + ROUND_2;

const proto = (label: string) =>
  `<html><head><title>${label}</title></head><body><div id="out">static ${label}</div><script>document.getElementById("out").textContent = "script ran in ${label}";</script></body></html>`;

/** Tries everything a prototype must not be able to do, recording what happened. */
const HOSTILE = `<!-- <head> a fake head to capture an injected policy </head> -->
<html><head></head><body>
<div id="out">static</div>
<img id="outside" src="../../secret.png">
<script>
document.getElementById("out").textContent = "script ran";
fetch("https://example.com/").then(() => { document.body.dataset.fetch = "ok"; }, () => { document.body.dataset.fetch = "blocked"; });
try { document.body.dataset.parent = String(window.parent.document.title); } catch (e) { document.body.dataset.parent = "blocked"; }
try { top.location = "https://example.com/"; document.body.dataset.top = "attempted"; } catch (e) { document.body.dataset.top = "blocked"; }
setTimeout(() => { location.href = "https://example.com/self-navigation"; }, 2000);
</script>
</body></html>`;

const ASSETS_TEXT: Record<string, string> = {
  "/x/alpha/grill-assets/A1/tabs.html": proto("tabs"),
  "/x/alpha/grill-assets/A1/slides.html": proto("slides"),
  "/x/alpha/grill-assets/A4/hostile.html": HOSTILE,
  "/x/alpha/grill-assets/A4/refresh.html": `<html><head><meta http-equiv="refresh" content="0; url=https://example.com/refresh"></head><body><div id="out">refresh</div></body></html>`,
};

type GrillFs = { files: Record<string, string>; versions: Record<string, number>; b64: Record<string, string> };

async function configure(page: Page, grill: string) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message, e.stack?.split("\n").slice(0, 4).join(" | ")));
  await page.addInitScript(
    ({ grill, grillPath, assets, png }) => {
      const fs: GrillFs = {
        files: { [grillPath]: grill, ...assets },
        versions: {},
        b64: { "/x/alpha/grill-assets/A1/flow.png": png, "/x/secret.png": png },
      };
      (window as unknown as { __GRILL_FS__: GrillFs }).__GRILL_FS__ = fs;
      (window as unknown as { __WS_DEMO_SEED__?: unknown }).__WS_DEMO_SEED__ = {
        projects: [{ name: "Demo", directory: "/repos/demo" }],
        workstreams: [
          {
            name: "Plan demo",
            directory: "/repos/demo",
            project: "Demo",
            tiles: [{ type: "copilot_session", title: "Plan demo", config: { pinned: true, copilot_session_id: "e2e-session" } }],
          },
        ],
      };
      const read = ({ path }: { path: string }) => {
        const content = fs.files[path];
        if (content === undefined) throw new Error(`NotFound: ${path}`);
        return {
          content,
          hash_hex: String(fs.versions[path] ?? 0),
          mtime_unix_ms: 1,
          line_ending: "lf",
          has_trailing_newline: content.endsWith("\n"),
          sniffed_binary: false,
          size_bytes: content.length,
        };
      };
      const write = ({ args }: { args: { path: string; content: string; expected_hash_hex: string | null; ensure_trailing_newline: boolean } }) => {
        const current = String(fs.versions[args.path] ?? 0);
        if (args.expected_hash_hex !== null && args.expected_hash_hex !== current) {
          throw JSON.stringify({ kind: "ExternalModified", current_hash_hex: current });
        }
        let content = args.content;
        if (args.ensure_trailing_newline && !content.endsWith("\n")) content += "\n";
        fs.files[args.path] = content;
        fs.versions[args.path] = (fs.versions[args.path] ?? 0) + 1;
        return { mtime_unix_ms: 1, hash_hex: String(fs.versions[args.path]) };
      };
      const handlers: Record<string, (args: never) => unknown> = {
        get_setting: () => null,
        set_setting: () => null,
        spawn_terminal: () => null,
        spawn_copilot_session: () => null,
        read_session_file: () => "# plan\n",
        list_session_features: () => ({ features: [], currentPlanId: null }),
        watch_session_features: () => null,
        unwatch_session_features: () => null,
        get_copilot_sessions: () => [],
        canonicalize_path: ({ path }: { path: string }) => path,
        watch_file_changes: () => null,
        unwatch_file_changes: () => null,
        read_text_file: read,
        write_text_file: write,
        read_file_base64: ({ path }: { path: string }) => {
          const data = fs.b64[path];
          if (data === undefined) throw new Error(`NotFound: ${path}`);
          return data;
        },
      };
      (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
    },
    { grill, grillPath: GRILL_PATH, assets: ASSETS_TEXT, png: PNG },
  );
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    const backend = (window as unknown as { __WS_BACKEND__?: { seedSessionFeatures: (id: string, payload: unknown) => void } }).__WS_BACKEND__;
    if (!backend) throw new Error("Memory backend is unavailable");
    backend.seedSessionFeatures("e2e-session", {
      features: [
        {
          name: "alpha", hasGrillMe: true, hasPlan: true, grillMePath: "/x/alpha/grill-me.md", planPath: "/x/alpha/plan.md",
          planId: "alpha-plan", planTitle: "Alpha", planStatus: "active", planCreatedAt: "2026-09-01T10:00:00.000Z",
          derivedStatus: "active", todosTotal: 1, todosDone: 0, todosInProgress: 0, todosBlocked: 0,
        },
      ],
      currentPlanId: "alpha-plan",
    });
  });
}

async function openGrill(page: Page) {
  await page.locator('[data-testid="workstream-item"]').first().click();
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-plan"]').click();
  await page.locator('[data-testid="plan-tab-grill"]').click();
  await expect(page.locator('[data-testid="grill-answer-view"]')).toBeVisible();
}

const fileText = (page: Page) =>
  page.evaluate((path) => (window as unknown as { __GRILL_FS__: GrillFs }).__GRILL_FS__.files[path], GRILL_PATH);

const setFile = (page: Page, text: string) =>
  page.evaluate(({ path, text }) => {
    const fs = (window as unknown as { __GRILL_FS__: GrillFs }).__GRILL_FS__;
    fs.files[path] = text;
    fs.versions[path] = (fs.versions[path] ?? 0) + 1;
  }, { path: GRILL_PATH, text });

const card = (page: Page) => page.locator('[data-testid="grill-question"]');
const markerIds = (page: Page) =>
  page.locator('[data-testid="grill-marker"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
const answered = (text: string, id: string, answer: string) =>
  text.replace(new RegExp(`(### ${id}\\. [\\s\\S]*?\\n)\\*\\*Answer:\\*\\*\\n`), `$1**Answer:** ${answer}\n`);

test.describe("grill Answer mode", () => {
  test("AT-1: the Plan tile is there unflagged and its Grill tab opens in Answer mode", async ({ page }) => {
    await configure(page, GRILL);
    await openGrill(page);
    const segments = page.locator('[data-testid="grill-mode-selector"] button');
    await expect(segments).toHaveText(["Answer", "Edit", "Preview", "Slides"]);
    await expect(page.locator('[data-testid="grill-mode-answer"]')).toHaveAttribute("aria-checked", "true");
  });

  test("AT-2: one question per screen, keyboard navigation and the overview strip", async ({ page }) => {
    await configure(page, GRILL);
    await openGrill(page);
    const view = page.locator('[data-testid="grill-answer-view"]');
    await expect(card(page)).toHaveCount(1);
    await expect(card(page)).toHaveAttribute("data-id", "A1");
    await view.focus();
    await page.keyboard.press("ArrowRight");
    await expect(card(page)).toHaveAttribute("data-id", "A2");
    await page.keyboard.press("Enter");
    await expect(card(page)).toHaveAttribute("data-id", "A3");
    await page.keyboard.press("ArrowLeft");
    await expect(card(page)).toHaveAttribute("data-id", "A2");
    await expect(card(page)).toHaveCount(1);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("2");
    await expect(page.locator('[data-testid="grill-option-b"]')).toHaveAttribute("aria-checked", "true");

    const markers = page.locator('[data-testid="grill-marker"]');
    await expect(markers).toHaveCount(5);
    expect(await markers.evaluateAll((els) => els.map((e) => e.getAttribute("data-importance")))).toEqual(["Low", "Medium", "High", "Blocking", "Medium"]);
    // A3 was just answered with the number key: three filled now, A1 and A4 still open.
    expect(await markers.evaluateAll((els) => els.map((e) => e.getAttribute("data-answered")))).toEqual(["false", "true", "true", "false", "true"]);
    const colours = await markers.evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopColor));
    expect(colours[1]).toBe(colours[4]);
    expect(new Set([colours[0], colours[1], colours[2], colours[3]]).size).toBe(4);
    await markers.nth(3).click();
    await expect(card(page)).toHaveAttribute("data-id", "A4");
  });

  test("AT-3: earlier rounds are visible but cannot be changed", async ({ page }) => {
    await configure(page, GRILL);
    await openGrill(page);
    await expect(page.locator('[data-testid="grill-round"]')).toHaveValue("2");
    const before = await fileText(page);
    await page.locator('[data-testid="grill-round"]').selectOption("1");
    await expect(card(page)).toContainText("Where it lives");
    await expect(page.locator('[data-testid="grill-answer"]')).toBeDisabled();
    await expect(page.locator('[data-testid="grill-option-b"]')).toBeDisabled();
    await expect(page.locator('[data-testid="grill-importance"]')).toBeDisabled();
    await expect(page.locator('[data-testid="grill-finish"]')).toHaveCount(0);
    await page.locator('[data-testid="grill-answer-view"]').focus();
    await page.keyboard.press("2");
    await page.waitForTimeout(700);
    expect(await fileText(page)).toBe(before);
  });

  test("AT-4: answers land in their own slots and keep a round the agent appended", async ({ page }) => {
    await configure(page, GRILL);
    await openGrill(page);
    await page.locator('[data-testid="grill-option-b"]').click();
    await page.locator('[data-testid="grill-option-note"]').fill("only on the phone");
    const appendedRound = "\n## Round 3 — later\n\n### A1. Later question\n**Importance:** Low\n\n**Recommendation:** x\n\n**Answer:**\n";
    await setFile(page, (await fileText(page)) + appendedRound);
    await page.locator('[data-testid="grill-next"]').click();
    await page.locator('[data-testid="grill-next"]').click();
    await page.locator('[data-testid="grill-answer"]').fill("a database, please");
    await expect.poll(() => fileText(page)).toContain("**Answer:** a database, please");
    const expected = answered(answered(GRILL + appendedRound, "A1", "b — only on the phone").replace(ROUND_1, ""), "A3", "a database, please");
    expect(await fileText(page)).toBe(ROUND_1 + expected);
    await expect(page.locator('[data-testid="grill-round"]')).toHaveValue("2");
  });

  test("AT-5: importance drives the filter and can be overridden", async ({ page }) => {
    await configure(page, GRILL);
    await openGrill(page);
    await page.locator('[data-testid="grill-threshold"]').selectOption("High");
    expect(await markerIds(page)).toEqual(["A3", "A4"]);
    await page.locator('[data-testid="grill-option-a"]').click();
    await page.locator('[data-testid="grill-unanswered-only"]').check();
    await expect.poll(() => markerIds(page)).toEqual(["A4"]);
    await page.locator('[data-testid="grill-threshold"]').selectOption("All");
    await page.locator('[data-testid="grill-marker"][data-id="A1"]').click();
    await page.locator('[data-testid="grill-importance"]').selectOption("High");
    await expect.poll(() => fileText(page)).toContain("### A1. Layout\n**Importance:** High (you)");
    await page.locator('[data-testid="grill-threshold"]').selectOption("High");
    await expect.poll(() => markerIds(page)).toEqual(["A1", "A4"]);
  });

  test("AT-6: a Blocking question cannot take the recommendation", async ({ page }) => {
    await configure(page, GRILL);
    await openGrill(page);
    await page.locator('[data-testid="grill-marker"][data-id="A4"]').click();
    await page.locator('[data-testid="grill-reveal"]').click();
    await expect(page.locator('[data-testid="grill-recommendation-text"]')).toContainText("sandbox everything");
    await expect(page.locator('[data-testid="grill-accept"]')).toHaveCount(0);
    await page.locator('[data-testid="grill-finish"]').click();
    await expect(page.locator('[data-testid="grill-finish-refused"]')).toContainText("A4");
    expect(await fileText(page)).toBe(GRILL);
  });

  test("AT-7: Finish round records the defaults honestly and sends nothing", async ({ page }) => {
    const start = answered(GRILL, "A4", "my own answer").replace("**Answer:** fine", "**Answer:**");
    await configure(page, start);
    await openGrill(page);
    await page.locator('[data-testid="grill-threshold"]').selectOption("Blocking");
    await page.locator('[data-testid="grill-finish"]').click();
    await expect(page.locator('[data-testid="grill-finish-confirm"]')).toContainText("3 unanswered questions (A1, A3, A5)");
    await page.locator('[data-testid="grill-finish-ok"]').click();
    const expected = start.replace(ROUND_1, "").replace(/\*\*Answer:\*\*\n/g, "**Answer:** reco (default — not reviewed)\n");
    await expect.poll(() => fileText(page)).toBe(ROUND_1 + expected);
    const commands = await page.evaluate(() => (window as unknown as { __WS_INVOKE_LOG__: { cmd: string }[] }).__WS_INVOKE_LOG__.map((c) => c.cmd));
    expect(commands).not.toContain("write_to_pty");
  });

  test("AT-8: the recommendation stays hidden until asked for", async ({ page }) => {
    await configure(page, GRILL);
    await openGrill(page);
    await expect(card(page)).not.toContainText("tabs are simpler");
    await expect(page.locator('[data-testid="grill-accept"]')).toHaveCount(0);
    await page.locator('[data-testid="grill-reveal"]').click();
    await expect(card(page)).toContainText("tabs are simpler");
    await page.locator('[data-testid="grill-accept"]').click();
    await expect.poll(() => fileText(page)).toBe(answered(GRILL.replace(ROUND_1, ""), "A1", "reco").replace(/^/, ROUND_1));
    await page.locator('[data-testid="grill-always-show-reco"]').check();
    await page.locator('[data-testid="grill-marker"][data-id="A3"]').click();
    await expect(page.locator('[data-testid="grill-recommendation-text"]')).toBeVisible();
    const settings = await page.evaluate(() =>
      (window as unknown as { __WS_INVOKE_LOG__: { cmd: string; args: Record<string, unknown> }[] }).__WS_INVOKE_LOG__
        .filter((c) => c.cmd === "set_setting").map((c) => c.args));
    expect(settings).toContainEqual({ key: "grill.always-show-reco", value: "1" });
  });

  test("AT-9: mermaid, images and per-option prototypes render, with a comparison", async ({ page }) => {
    await configure(page, GRILL);
    await openGrill(page);
    await expect(card(page).locator('[data-testid="grill-context"] svg').first()).toBeVisible({ timeout: 15_000 });
    const image = card(page).locator('[data-testid="grill-visual"][data-path="grill-assets/A1/flow.png"] img');
    await expect(image).toHaveAttribute("src", `data:image/png;base64,${PNG}`);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
    const rows = page.locator('[data-testid="grill-option-row"]');
    await expect(rows.nth(0).locator("iframe")).toHaveAttribute("title", "Tabs");
    await expect(rows.nth(1).locator("iframe")).toHaveAttribute("title", "Slides");
    await expect(page.frameLocator('[data-testid="grill-option-row"][data-option="a"] iframe').locator("#out")).toHaveText("script ran in tabs");
    await page.locator('[data-testid="grill-compare"]').click();
    const frames = page.locator('[data-testid="grill-comparison"] iframe');
    await expect(frames).toHaveCount(2);
    await expect(frames.nth(0)).toBeVisible();
    await expect(frames.nth(1)).toBeVisible();
  });

  test("AT-10: prototypes are sandboxed", async ({ page }) => {
    test.setTimeout(40_000);
    const withHostile = GRILL.replace(
      "**Recommendation:** sandbox everything",
      '**Visual:** grill-assets/A4/hostile.html "Hostile"\n**Visual:** grill-assets/A4/refresh.html "Refresh"\n\n**Recommendation:** sandbox everything',
    );
    // The browser may start a request the policy then blocks; what matters is
    // that none reaches a server.
    const outside = (u: string) => u.includes("example.com") || u.includes("secret.png");
    const reached: string[] = [];
    const blocked: string[] = [];
    page.on("response", (r) => { if (outside(r.url())) reached.push(r.url()); });
    await page.context().route(/example\.com/, (route) => { reached.push(route.request().url()); return route.fulfill({ body: "<p id=pwned>remote</p>", contentType: "text/html" }); });
    page.on("requestfailed", (r) => { if (outside(r.url())) blocked.push(`${r.url()} ${r.failure()?.errorText}`); });
    await configure(page, withHostile);
    await openGrill(page);
    const appUrl = page.url();
    await page.locator('[data-testid="grill-marker"][data-id="A4"]').click();
    const frame = page.frameLocator('[data-testid="grill-prototype"][title="Hostile"]');
    await expect(frame.locator("#out")).toHaveText("script ran");
    await expect(frame.locator("body")).toHaveAttribute("data-fetch", "blocked");
    await expect(frame.locator("body")).toHaveAttribute("data-parent", "blocked");
    expect(await frame.locator("#outside").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(0);
    await expect(page.locator('[data-testid="grill-prototype"][title="Hostile"]')).toHaveAttribute("sandbox", "allow-scripts");
    await page.waitForTimeout(3000);
    expect(page.url()).toBe(appUrl);
    // The self-navigation and the refresh are refused by the app page's
    // frame-src: the browser may show its own error page in the frame, but the
    // remote page never loads.
    await expect(frame.locator("#pwned")).toHaveCount(0);
    await expect(page.frameLocator('[data-testid="grill-prototype"][title="Refresh"]').locator("#pwned")).toHaveCount(0);
    await expect(page.locator('[data-testid="grill-answer-view"]')).toBeVisible();
    expect(reached).toEqual([]);
    expect(blocked.every((b) => b.endsWith(" csp"))).toBe(true);
  });

  test("AT-13: an old grill opens with Medium everywhere, options where they can be read", async ({ page }) => {
    const old = readFileSync(new URL("../../src/domain/grill/__tests__/fixtures/old-format.md", import.meta.url), "utf8");
    await configure(page, old);
    await openGrill(page);
    await page.locator('[data-testid="grill-round"]').selectOption("1");
    const importances = await page.locator('[data-testid="grill-marker"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-importance")));
    expect(importances.length).toBeGreaterThan(5);
    expect(new Set(importances)).toEqual(new Set(["Medium"]));
    let withOptions = 0;
    let withoutOptions = 0;
    for (let i = 0; i < importances.length; i += 1) {
      await page.locator('[data-testid="grill-marker"]').nth(i).click();
      await expect(page.locator('[data-testid="grill-answer"]')).toBeVisible();
      if ((await page.locator('[data-testid^="grill-option-"][role="radio"]').count()) > 0) withOptions += 1;
      else withoutOptions += 1;
    }
    expect(withOptions).toBeGreaterThan(0);
    expect(withoutOptions).toBeGreaterThan(0);
  });
});
