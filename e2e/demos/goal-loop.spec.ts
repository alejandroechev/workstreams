import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import type { DemoMemorySeed } from "../../src/backend/demo-seed";

const VIEWPORT = { width: 1280, height: 800 } as const;
const WORKSTREAM_ROOT = "/demo/atlas/worktrees/retry-reliability";
const DEFINITION_PATH =
  "/sessions/demo-goal-loop-001/files/loops/retry-reliability.loop.yaml";
const DEMO_SEED: DemoMemorySeed = {
  projects: [{ name: "Atlas", directory: "/demo/atlas", color: "#89b4fa" }],
  workstreams: [
    {
      name: "Retry reliability",
      directory: WORKSTREAM_ROOT,
      project: "Atlas",
      workstreamType: "worktree",
      worktreeBranch: "demo/retry-reliability",
      tiles: [{ type: "loop_control", title: "Goal Loop" }],
    },
  ],
};

async function waitForStableFrame(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function installSyntheticHost(page: Page): Promise<void> {
  await page.addInitScript(({ seed }) => {
    const handlers: Record<
      string,
      (args: Record<string, unknown>) => unknown | Promise<unknown>
    > = {
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
    target.__WS_DEMO_SEED__ = seed;
    target.__WS_INVOKE_HANDLERS__ = handlers;
    target.__WS_INVOKE_LOG__ = [];
  }, { seed: DEMO_SEED });
}

async function seedGoalLoop(page: Page): Promise<void> {
  await page.evaluate(
    async ({ definitionPath, workstreamRoot }) => {
      const backend = (window as unknown as {
        __WS_BACKEND__?: {
          listWorkstreams: () => Promise<Array<{ id: string; name: string }>>;
          readFile: (path: string) => Promise<string>;
          seedFile: (path: string, content: string) => void;
          seedLoopDelayScale: (scale: number) => void;
          seedLoopDefinition: (
            definition: Record<string, unknown>,
            spec: Record<string, unknown>,
            workstreamId?: string,
          ) => void;
        };
      }).__WS_BACKEND__;
      if (!backend) throw new Error("Synthetic MemoryBackend is unavailable");
      const workstream = (await backend.listWorkstreams()).find(
        (candidate) => candidate.name === "Retry reliability",
      );
      if (!workstream) throw new Error("Synthetic workstream is unavailable");
      backend.seedLoopDelayScale(2);

      const yaml = `apiVersion: workstreams.dev/v1alpha1
kind: Loop
metadata:
  id: retry-reliability
  name: Retry reliability goal
  tags: [reliability, demo]
spec:
  objective: Keep checkout retries bounded and verified.
  orchestrator:
    prompt: Select one unverified retry behavior.
  worker:
    prompt: Implement bounded retry behavior with tests.
  verification:
    command:
      program: npm
      args: [test, --, retry-policy]
  evaluator:
    prompt: Confirm the evidence satisfies the objective.
  limits:
    runTimeout: 5m
    taskAttempts: 2
`;
      backend.seedFile(definitionPath, yaml);
      backend.seedLoopDefinition(
        {
          id: "retry-reliability",
          name: "Retry reliability goal",
          description: "Prove bounded retries with deterministic evidence.",
          tags: ["reliability", "demo"],
          path: definitionPath,
          hash: "sha256:7b3d8c2f0a61",
          portable: true,
          objective: "Keep checkout retries bounded and verified.",
          hasVerification: true,
          hasEvaluator: true,
          hasHumanApproval: false,
        },
        {
          orchestrator: {
            prompt: "Select one unverified retry behavior.",
            model: "",
          },
          worker: {
            prompt: "Implement bounded retry behavior with tests.",
            model: "",
          },
          evaluator: {
            prompt: "Confirm the evidence satisfies the objective.",
            model: "",
          },
          verifier: {
            program: "npm",
            args: ["test", "--", "retry-policy"],
            cwd: workstreamRoot,
          },
          runTimeoutMs: 5 * 60_000,
          maxTaskIterations: 2,
        },
        workstream.id,
      );

      const handlers = (window as unknown as {
        __WS_INVOKE_HANDLERS__?: Record<
          string,
          (args: Record<string, unknown>) => unknown | Promise<unknown>
        >;
      }).__WS_INVOKE_HANDLERS__;
      if (!handlers) throw new Error("Synthetic host handlers are unavailable");
      handlers.canonicalize_path = ({ path }) => path;
      handlers.read_text_file = async ({ path }) => {
        const content = await backend.readFile(String(path));
        return {
          content,
          mtime_unix_ms: 1,
          hash_hex: `synthetic-${content.length}`,
          line_ending: "lf",
          has_trailing_newline: content.endsWith("\n"),
          sniffed_binary: false,
          size_bytes: content.length,
        };
      };
      handlers.watch_file_changes = () => null;
      handlers.unwatch_file_changes = () => null;
    },
    { definitionPath: DEFINITION_PATH, workstreamRoot: WORKSTREAM_ROOT },
  );
}

test("records a deterministic Goal Loop run", async ({ page }) => {
  const clipId = process.env.WORKSTREAMS_DEMO_CLIP;
  const outputDir = process.env.WORKSTREAMS_DEMO_OUTPUT_DIR;
  if (!clipId || !outputDir) {
    throw new Error("Run this scenario through the demo media recorder");
  }

  await installSyntheticHost(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/");
  const workstream = page.getByText("Retry reliability", { exact: true });
  await expect(workstream).toBeVisible();
  await seedGoalLoop(page);
  await workstream.click();

  const loopTile = page.locator('[data-testid="loop-control-tile"]');
  await expect(loopTile).toBeVisible();
  await page.locator('[data-testid="loop-refresh"]').click();
  await expect(page.locator('[data-testid="loop-definition-title"]')).toContainText(
    "Retry reliability goal",
  );
  await loopTile.click();
  await page.locator('[data-testid="toggle-fullscreen"]').click();
  await expect(page.getByText("⛶ Full", { exact: true })).toBeVisible();

  await expect(
    page.locator('[data-testid="loop-definition-editor-header"]'),
  ).toContainText("retry-reliability.loop.yaml");
  const editor = loopTile.locator(".monaco-editor");
  await expect(editor).toBeVisible();
  await expect(editor.locator(".view-lines")).toContainText("taskAttempts: 2");
  await waitForStableFrame(page);

  fs.mkdirSync(outputDir, { recursive: true });
  const recordingPath = path.join(outputDir, `${clipId}.raw.webm`);
  await page.screencast.start({
    path: recordingPath,
    size: VIEWPORT,
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
    await page.waitForTimeout(1_000);
    await page.locator('[data-testid="loop-run-selected"]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="loop-run-state"]')
          ?.textContent?.includes("Working") === true,
      null,
      { polling: "raf" },
    );
    await page.waitForTimeout(200);
    await page.locator('[data-testid="loop-pause"]').click();
    await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
      "Paused",
    );
    await page.locator('[data-testid="loop-resume"]').click();

    await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
      "Completed",
      { timeout: 5_000 },
    );
    await expect(page.locator('[data-testid="loop-time-breakdown"]')).toContainText(
      "orchestrator 1s (1)",
    );
    await expect(page.locator('[data-testid="loop-slowest-stage"]')).toContainText(
      "worker #1 — 3s",
    );

    const taskList = page.locator('[data-testid="loop-task-list"]');
    await taskList.locator(":scope > summary").click();
    const task = page.locator('article[data-testid^="loop-task-"]').first();
    await expect(task).toContainText("accepted");
    await task.locator("summary", { hasText: "Details" }).click();
    await expect(
      task.locator('[data-testid^="loop-task-stage-timings-"]'),
    ).toContainText("worker #1: 3s");
    await expect(
      task.locator('[data-testid^="loop-worker-evidence-"]'),
    ).toContainText("src/retry-policy.test.ts: 8 assertions passed");
    await expect(task.locator('[data-testid^="loop-verification-"]')).toContainText(
      "8 deterministic assertions passed",
    );
    await expect(task.locator('[data-testid^="loop-evaluation-"]')).toContainText(
      "Bounded retry behavior matches the objective",
    );
    await task.locator('[data-testid^="loop-evaluation-"]').scrollIntoViewIfNeeded();
    await waitForStableFrame(page);
    await page.waitForTimeout(1_000);
    succeeded = true;
  } finally {
    await actions.dispose();
    if (succeeded) await page.screencast.stop();
    else await page.screencast.stop().catch(() => {});
    if (!succeeded) fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
