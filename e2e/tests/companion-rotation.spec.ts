/**
 * Rotating the phone companion's document from Settings (ADR 033). The page
 * talks to in-memory documents by URL instead of the sync server (the
 * VITE_E2E seam in main.tsx).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const SECRET: string = JSON.parse(
  readFileSync(new URL("../../src/companion/protocol/fixtures.json", import.meta.url), "utf8"),
).secret;
const OLD = "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh";

test("AT-4: Rotate now moves the companion to a new document and says so", async ({ page }) => {
  await page.addInitScript(({ secret, old }) => {
    const settings: Record<string, string> = {
      "companion.enabled": "1", "companion.doc_url": old, "companion.secret": secret, "companion.folder_root": "/phone",
    };
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: {
        get_setting: (args: { key: string }) => settings[args.key] ?? null,
        set_setting: (args: { key: string; value: string }) => { settings[args.key] = args.value; return null; },
      },
      __WS_DEMO_SEED__: { workstreams: [{ name: "Alpha", directory: "/alpha" }] },
      __WS_COMPANION_E2E__: settings,
    });
  }, { secret: SECRET, old: OLD });
  await page.goto("/");
  await expect(page.getByTestId("workstream-item").first()).toBeVisible();

  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-tab-companion").click();
  await expect(page.getByTestId("companion-status")).toContainText(/connected/i);
  await page.screenshot({ path: "test-results/companion-rotation-1.png" });

  await page.getByTestId("companion-rotate").click();
  await expect(page.getByTestId("companion-rotate-result")).toHaveText("Moved to a new document. The phone follows by itself.");
  await page.screenshot({ path: "test-results/companion-rotation-3.png" });

  const docs = await page.evaluate(({ old }) => {
    const read = (window as unknown as { __WS_COMPANION_DOC__: (url: string) => { schemaVersion: number; movedTo?: { doc: string }; laptop: { workstreams: unknown[] } } }).__WS_COMPANION_DOC__;
    return { old: read(old), fresh: read("automerge:3RotatedDoc1") };
  }, { old: OLD });
  expect(docs.old.movedTo?.doc).toBe("automerge:3RotatedDoc1");
  expect(docs.old.schemaVersion).toBe(2);
  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { __WS_COMPANION_DOC__: (url: string) => { laptop: { workstreams: unknown[] } } }).__WS_COMPANION_DOC__("automerge:3RotatedDoc1").laptop.workstreams.length,
  )).toBe(1);
});
