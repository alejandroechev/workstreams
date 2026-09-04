import {
  expect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import type { DemoMemorySeed } from "../../src/backend/demo-seed";

export const DEMO_VIEWPORT = { width: 1280, height: 800 } as const;
const FINAL_HOLD_MS = 1_000;

type InvokeHandler = (
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface DemoRecorder {
  page: Page;
  showChapter(
    title: string,
    options?: { description?: string; duration?: number },
  ): Promise<void>;
  settled(locator?: Locator): Promise<void>;
}

interface DemoFixtures {
  demo: DemoRecorder;
  demoSeed: DemoMemorySeed;
}

async function installSyntheticHost(
  page: Page,
  seed: DemoMemorySeed,
): Promise<void> {
  await page.addInitScript(({ demoSeed }) => {
    const handlers: Record<string, InvokeHandler> = {
      get_setting: () => null,
      set_setting: () => null,
      spawn_terminal: () => null,
      write_to_pty: () => null,
      resize_pty: () => null,
      close_terminal: () => null,
      load_scrollback: () => null,
      save_scrollback: () => null,
      watch_session: () => null,
      unwatch_session: () => null,
      watch_directory: () => null,
      unwatch_directory: () => null,
    };
    const target = window as unknown as {
      __WS_DEMO_SEED__: DemoMemorySeed;
      __WS_INVOKE_HANDLERS__: typeof handlers;
      __WS_INVOKE_LOG__: unknown[];
    };
    target.__WS_DEMO_SEED__ = demoSeed;
    target.__WS_INVOKE_HANDLERS__ = handlers;
    target.__WS_INVOKE_LOG__ = [];
  }, { demoSeed: seed });
}

async function waitForStableFrame(page: Page, locator?: Locator): Promise<void> {
  if (locator) await expect(locator).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

export const test = base.extend<DemoFixtures>({
  demoSeed: [{}, { option: true }],
  demo: async ({ page, demoSeed }, use) => {
    const clipId = process.env.WORKSTREAMS_DEMO_CLIP;
    const outputDir = process.env.WORKSTREAMS_DEMO_OUTPUT_DIR;
    if (!clipId || !outputDir) {
      throw new Error(
        "Demo scenarios must run through 'npm run demos:record' with a declared clip",
      );
    }

    await installSyntheticHost(page, demoSeed);
    await page.setViewportSize(DEMO_VIEWPORT);
    await page.goto("/");
    await waitForStableFrame(page, page.locator("#root"));

    fs.mkdirSync(outputDir, { recursive: true });
    const recording = path.join(outputDir, `${clipId}.raw.webm`);
    await page.screencast.start({
      path: recording,
      size: DEMO_VIEWPORT,
      quality: 90,
      annotate: { duration: 700, position: "bottom-right", fontSize: 20 },
    });
    const actions = await page.screencast.showActions({
      duration: 700,
      position: "bottom-right",
      fontSize: 20,
    });

    let succeeded = false;
    try {
      await use({
        page,
        showChapter: async (title, options) => {
          await page.screencast.showChapter(title, options);
          await page.waitForTimeout(options?.duration ?? 2_000);
          await waitForStableFrame(page);
        },
        settled: (locator) => waitForStableFrame(page, locator),
      });
      await waitForStableFrame(page);
      await page.waitForTimeout(FINAL_HOLD_MS);
      succeeded = true;
    } finally {
      await actions.dispose();
      if (succeeded) await page.screencast.stop();
      else await page.screencast.stop().catch(() => {});
      if (!succeeded) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    }
  },
});

export { expect };
