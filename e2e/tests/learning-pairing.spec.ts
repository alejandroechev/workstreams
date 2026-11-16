/**
 * Rust Pocket pairs on its own, next to the phone companion (ADR 042, C-AT-5):
 * unpairing or re-pairing it never touches the companion's pairing.
 */
import { test, expect } from "@playwright/test";

const LEARNING_DOC = "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh";

test("Rust Pocket pairs and unpairs without touching the companion", async ({ page }) => {
  await page.addInitScript((doc) => {
    const settings = new Map<string, string>(Object.entries({
      "companion.enabled": "1",
      "companion.server_url": "https://sync.example",
      "companion.token": "companion-jwt",
      "companion.doc_url": "automerge:4H1cVwdhy8YzwGQTUdPA1mVqsfxo",
      "companion.secret": "c".repeat(43),
      "learning.server_url": "https://sync.example",
      "learning.doc_url": doc,
    }));
    Object.assign(window, {
      __WS_SETTINGS__: settings,
      __WS_INVOKE_HANDLERS__: {
        get_setting: ({ key }: { key: string }) => settings.get(key) ?? null,
        set_setting: ({ key, value }: { key: string; value: string }) => { settings.set(key, value); return null; },
      },
    });
  }, LEARNING_DOC);
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-tab-companion").click();

  const companionCode = page.getByTestId("companion-pairing-code");
  const before = await companionCode.inputValue();
  expect(JSON.parse(before)).toMatchObject({ secret: "c".repeat(43) });

  await page.getByTestId("learning-pair").click();
  await expect(page.getByTestId("learning-qr").locator("svg")).toBeVisible();
  const learningCode = JSON.parse(await page.getByTestId("learning-pairing-code").inputValue());
  expect(learningCode).toMatchObject({ v: 1, app: "rust-pocket", doc: LEARNING_DOC, server: "https://sync.example" });
  expect(learningCode.secret).toMatch(/^[a-f0-9]{64}$/);
  expect(await companionCode.inputValue()).toBe(before);

  await page.getByTestId("learning-unpair").click();
  await page.getByTestId("learning-unpair-confirm").click();
  await expect(page.getByTestId("learning-pair")).toBeVisible();
  await expect(page.getByTestId("learning-qr")).toHaveCount(0);
  await expect(page.getByTestId("companion-qr").locator("svg")).toBeVisible();
  expect(await companionCode.inputValue()).toBe(before);
  const stored = await page.evaluate(() => {
    const s = (window as unknown as { __WS_SETTINGS__: Map<string, string> }).__WS_SETTINGS__;
    return { learning: s.get("learning.secret"), companion: s.get("companion.secret"), enabled: s.get("companion.enabled") };
  });
  expect(stored).toEqual({ learning: "", companion: "c".repeat(43), enabled: "1" });
});
