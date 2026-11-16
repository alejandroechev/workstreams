/**
 * Rust Pocket's checks travel through a learning document of their own
 * (ADR 042, C-AT-4). The spec plays the phone (an in-memory peer of the
 * learning document) and the native ledger (invoke handlers); the app is the
 * relay in between. The companion document must not change.
 */
import { test, expect } from "@playwright/test";

const SECRET = "ab".repeat(32);

test("a check goes out through the learning document and its signed result comes back", async ({ page }) => {
  await page.addInitScript((secret) => {
    const jobs = new Map<string, { id: string; kind: string; status: string; result: unknown }>();
    const enqueued: unknown[] = [];
    Object.assign(window, {
      __LEDGER_JOBS__: jobs,
      __ENQUEUED__: enqueued,
      __WS_INVOKE_HANDLERS__: {
        get_setting: () => null,
        set_setting: () => null,
        learning_enqueue: ({ request }: { request: { id: string; kind: string } }) => {
          enqueued.push(request);
          const job = { id: request.id, kind: request.kind, status: "finished", result: { status: "passed", output: "1 passed", toolchain: "rustc 1.98.0" } };
          jobs.set(request.id, job);
          return job;
        },
        learning_job: ({ id }: { id: string }) => jobs.get(id) ?? null,
      },
      __WS_LEARNING_E2E__: { "learning.doc_url": "automerge:learn", "learning.secret": secret, "learning.server_url": "https://sync.example" },
      __WS_COMPANION_E2E__: { "companion.enabled": "1", "companion.doc_url": "automerge:companion", "companion.secret": "c".repeat(43) },
    });
  }, SECRET);
  await page.goto("/");
  await page.waitForFunction(() => "__WS_LEARNING_PHONE__" in window && "__WS_COMPANION_PHONE__" in window);

  const companionBefore = await page.evaluate(() => {
    const phone = (window as unknown as { __WS_COMPANION_PHONE__: { read(): { requests: object } } }).__WS_COMPANION_PHONE__;
    return Object.keys(phone.read().requests).length;
  });

  const request = {
    version: 1, id: "attempt-7", kind: "check", createdAt: Date.now(), cardId: "even", cardVersion: "2",
    source: "pub fn is_even(n: i32) -> bool { n % 2 == 0 }", harness: { tests: "assert!(is_even(2));" }, toolchain: "1.98.0",
  };
  await page.evaluate(async ({ request, secret }) => {
    const w = window as unknown as {
      __WS_LEARNING_PHONE__: { change(f: (d: { requests: Record<string, string> }) => void): void };
      __WS_LEARNING_SIGN__: (body: unknown, secret: string) => Promise<unknown>;
    };
    const envelope = await w.__WS_LEARNING_SIGN__(request, secret);
    w.__WS_LEARNING_PHONE__.change((d) => { d.requests[request.id] = JSON.stringify(envelope); });
  }, { request, secret: SECRET });

  await expect.poll(() => page.evaluate(() => {
    const phone = (window as unknown as { __WS_LEARNING_PHONE__: { read(): { results: Record<string, string> } } }).__WS_LEARNING_PHONE__;
    return phone.read().results["attempt-7"] ?? null;
  })).not.toBeNull();

  const outcome = await page.evaluate(async ({ secret }) => {
    const w = window as unknown as {
      __WS_LEARNING_PHONE__: { read(): { results: Record<string, string>; laptop?: { lastSeenAt: number } } };
      __WS_LEARNING_SIGN__: (body: unknown, secret: string) => Promise<{ signature: string }>;
      __ENQUEUED__: unknown[];
    };
    const doc = w.__WS_LEARNING_PHONE__.read();
    const envelope = JSON.parse(doc.results["attempt-7"]) as { body: unknown; signature: string };
    const resigned = await w.__WS_LEARNING_SIGN__(envelope.body, secret);
    return { body: envelope.body, authentic: resigned.signature === envelope.signature, enqueued: w.__ENQUEUED__, seen: typeof doc.laptop?.lastSeenAt };
  }, { secret: SECRET });
  expect(outcome.authentic).toBe(true);
  expect(outcome.body).toMatchObject({ id: "attempt-7", result: { status: "passed", output: "1 passed" } });
  expect((outcome.body as { requestHash: string }).requestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(outcome.enqueued).toEqual([{
    kind: "check", id: "attempt-7", card_id: "even", card_version: "2",
    harness: { tests: "assert!(is_even(2));" }, source: request.source, toolchain: "1.98.0",
  }]);
  expect(outcome.seen).toBe("number");

  const companionAfter = await page.evaluate(() => {
    const phone = (window as unknown as { __WS_COMPANION_PHONE__: { read(): { requests: object } } }).__WS_COMPANION_PHONE__;
    return Object.keys(phone.read().requests).length;
  });
  expect(companionAfter).toBe(companionBefore);
});
