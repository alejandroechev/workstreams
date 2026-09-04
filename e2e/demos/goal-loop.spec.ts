import { expect, test } from "./fixtures";

const WORKSTREAM_ROOT = "/demo/atlas/worktrees/retry-reliability";
const DEFINITION_PATH =
  "/sessions/demo-goal-loop-001/files/loops/retry-reliability.loop.yaml";

test.use({
  demoSeed: {
    projects: [
      { name: "Atlas", directory: "/demo/atlas", color: "#89b4fa" },
    ],
    workstreams: [
      {
        name: "Retry reliability",
        directory: WORKSTREAM_ROOT,
        project: "Atlas",
        workstreamType: "worktree",
        worktreeBranch: "demo/retry-reliability",
        tiles: [
          {
            type: "copilot_session",
            title: "Reliability session",
            config: {
              session_name: "Reliability session",
              cwd: WORKSTREAM_ROOT,
              copilot_session_id: "demo-goal-loop-001",
              is_resumed: true,
            },
          },
        ],
      },
    ],
  },
});

async function seedGoalLoop(page: import("@playwright/test").Page) {
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
  description: Prove bounded retries with deterministic evidence.
  tags: [reliability, demo]
spec:
  objective: Keep checkout retries bounded and fully verified.
  orchestrator:
    prompt: Select the next unverified retry behavior.
  worker:
    prompt: Implement one bounded retry behavior with tests.
  verification:
    command:
      program: npm
      args: [test, --, retry-policy]
  evaluator:
    prompt: Confirm the evidence satisfies the retry objective.
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
          objective: "Keep checkout retries bounded and fully verified.",
          hasVerification: true,
          hasEvaluator: true,
          hasHumanApproval: false,
        },
        {
          orchestrator: {
            prompt: "Select the next unverified retry behavior.",
            model: "",
          },
          worker: {
            prompt: "Implement one bounded retry behavior with tests.",
            model: "",
          },
          evaluator: {
            prompt: "Confirm the evidence satisfies the retry objective.",
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

test("records a deterministic Goal Loop run", async ({ demo }) => {
  const { page } = demo;
  const workstream = page.getByText("Retry reliability", { exact: true });
  await demo.settled(workstream);
  await seedGoalLoop(page);

  await workstream.click();
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-loop"]').click();
  const loopTile = page.locator('[data-testid="loop-control-tile"]');
  await demo.settled(loopTile);

  await page.locator('[data-testid="loop-tab-definitions"]').click();
  await expect(
    page.locator('[data-testid="loop-definition-editor-header"]'),
  ).toContainText("retry-reliability.loop.yaml");
  await expect(loopTile.locator(".monaco-editor")).toBeVisible();
  await demo.showChapter("Define the evidence contract", {
    description: "Reviewable YAML pins the objective, verifier, and evaluator",
    duration: 900,
  });
  await page.waitForTimeout(700);

  await page.locator('[data-testid="loop-tab-run"]').click();
  const selected = page.locator('[data-testid="loop-definition-selected"]');
  await expect(selected).toContainText("Retry reliability goal");
  await expect(selected).toContainText("sha256:7b3d8c2f0a61");
  await page.locator('[data-testid="loop-run-selected"]').click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="loop-run-state"]')
        ?.textContent?.includes("Working") === true,
    null,
    { polling: "raf" },
  );
  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Working",
  );
  await page.waitForTimeout(150);
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
  await task.locator('summary', { hasText: "Details" }).click();
  await expect(task.locator('[data-testid^="loop-task-stage-timings-"]')).toContainText(
    "worker #1: 3s",
  );
  await expect(task.locator('[data-testid^="loop-worker-evidence-"]')).toContainText(
    "src/retry-policy.test.ts: 8 assertions passed",
  );
  await expect(task.locator('[data-testid^="loop-verification-"]')).toContainText(
    "8 deterministic assertions passed",
  );
  await expect(task.locator('[data-testid^="loop-evaluation-"]')).toContainText(
    "Bounded retry behavior matches the objective",
  );
  await task.locator('[data-testid^="loop-evaluation-"]').scrollIntoViewIfNeeded();
  await demo.settled(task.locator('[data-testid^="loop-evaluation-"]'));
});
