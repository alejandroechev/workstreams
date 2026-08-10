/**
 * E2E: code walkthrough replay.
 *
 * Exercises the replay half end to end — trace picker, stepping, and the bound
 * Repo Explorer following along — against the VITE_E2E dev server
 * (MemoryBackend + Tauri invoke shim).
 *
 * No debugger is involved. That is precisely why record and replay were split:
 * the OS-dependent half stays in a CLI, so this flow is testable in a browser.
 */
import { test, expect, type Page } from "@playwright/test";

const TRACE_PATH = "/repo/.workstreams/traces/demo.json";

const TRACE = {
  version: 1,
  test: "pty::tests::resolves_shell",
  repoRoot: "/repo",
  commitSha: "abc1234",
  recordedAt: "2026-08-10T00:00:00.000Z",
  truncated: false,
  steps: [
    { file: "src/pty.rs", line: 10, function: "mycrate::pty::outer" },
    { file: "src/pty.rs", line: 20, function: "mycrate::pty::inner", hits: 3 },
    { file: "src/other.rs", line: 30, function: "mycrate::other::last" },
  ],
};

async function configure(page: Page) {
  await page.addInitScript(
    ({ tracePath, trace }) => {
      // Enable the flag-gated walkthrough tile for this run.
      (window as unknown as { __WS_FEATURE_FLAGS__?: boolean }).__WS_FEATURE_FLAGS__ = true;

      type Args = Record<string, unknown>;
      const handlers: Record<string, (a: Args) => unknown> = {
        get_setting: () => null,
        set_setting: () => null,
        spawn_terminal: () => null,
        spawn_copilot_session: () => null,
        write_to_pty: () => null,
        resize_pty: () => null,
        close_terminal: () => null,
        load_scrollback: () => null,
        save_scrollback: () => null,
        watch_session: () => null,
        unwatch_session: () => null,
        watch_directory: () => null,
        unwatch_directory: () => null,
        watch_file_changes: () => null,
        // The walkthrough asks whether the trace still matches the tree.
        trace_staleness: () => "fresh",
        list_directory: () => [],
        read_text_file: () => ({
          content: "line1\nline2\n",
          mtime_unix_ms: 0,
          hash_hex: "0",
          line_ending: "lf",
          has_trailing_newline: true,
          sniffed_binary: false,
          size_bytes: 12,
        }),
        canonicalize_path: (a: Args) => a.path,
      };
      (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;

      // Seed a recorded trace into the in-memory backend once it exists.
      const seed = () => {
        const backend = (window as unknown as { __WS_BACKEND__?: Record<string, unknown> }).__WS_BACKEND__;
        if (!backend) return false;
        (backend._seedTraceFile as (p: string, c: unknown) => void)(tracePath, trace);
        void (backend.indexCodeTrace as (p: string, w: string | null) => Promise<unknown>)(tracePath, null);
        return true;
      };
      const timer = setInterval(() => {
        if (seed()) clearInterval(timer);
      }, 50);
    },
    { tracePath: TRACE_PATH, trace: TRACE },
  );
}

async function createWorkstream(page: Page, name: string) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill(name);
  await page.locator('[data-testid="ws-create-submit"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
}

async function openWalkthroughTile(page: Page) {
  // Alt+D creates the walkthrough tile (Option+D on macOS resolves the same
  // way, because matching is on event.code).
  await page.keyboard.press("Alt+d");
  await expect(page.locator('[data-testid="debug-walkthrough-tile"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await configure(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
});

test.describe("Code walkthrough", () => {
  test("steps through a recorded trace forwards and backwards", async ({ page }) => {
    await createWorkstream(page, "Walkthrough WS");
    await openWalkthroughTile(page);

    const picker = page.getByLabel("Trace");
    await expect(picker.locator("option")).toHaveCount(2); // placeholder + trace
    await picker.selectOption(TRACE_PATH);

    const progress = page.locator('[data-testid="walkthrough-progress"]');
    await expect(progress).toHaveText("1 / 3");

    await page.getByLabel("Next step").click();
    await expect(progress).toHaveText("2 / 3");

    await page.getByLabel("Next step").click();
    await expect(progress).toHaveText("3 / 3");

    // Stepping *backwards* is the replay model's advantage over a live
    // debugger, so it is worth asserting rather than assuming.
    await page.getByLabel("Previous step").click();
    await expect(progress).toHaveText("2 / 3");
  });

  test("shows the recorded steps with collapsed hit counts", async ({ page }) => {
    await createWorkstream(page, "Walkthrough WS");
    await openWalkthroughTile(page);
    await page.getByLabel("Trace").selectOption(TRACE_PATH);

    await expect(page.getByText(/src\/pty\.rs:10/)).toBeVisible();
    await expect(page.getByText(/x3/)).toBeVisible();
  });

  test("jumps to a step clicked in the list", async ({ page }) => {
    await createWorkstream(page, "Walkthrough WS");
    await openWalkthroughTile(page);
    await page.getByLabel("Trace").selectOption(TRACE_PATH);

    await page.getByText(/src\/other\.rs:30/).click();
    await expect(page.locator('[data-testid="walkthrough-progress"]')).toHaveText("3 / 3");
  });

  test("tells the user to open a Repo Explorer when none is bound", async ({ page }) => {
    // Pressing Next with nothing bound must not silently do nothing.
    await createWorkstream(page, "Walkthrough WS");
    await openWalkthroughTile(page);
    await expect(page.getByText(/open a repo explorer/i)).toBeVisible();
  });
});
