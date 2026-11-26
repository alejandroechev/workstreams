import { describe, expect, it } from "vitest";
import { deliverRunResult, recordRunPrompt, type NotifyDeps } from "../notify";
import type { PeriodicRun, PeriodicSchedule } from "../../domain/periodic-schedules";

function setup(companion = true) {
  const inbox: Array<{ level: string; title: string; body: string; tile: string }> = [];
  const phone: Array<{ kind: string; text: string; tile: string }> = [];
  const deps: NotifyDeps = {
    postInbox: async (_ws, tile, level, title, body) => { inbox.push({ tile, level, title, body }); },
    postPhone: async (tile, _ws, kind, text) => { phone.push({ tile, kind, text }); },
    companionOn: async () => companion,
  };
  return { inbox, phone, deps };
}

const schedule = (over: Partial<PeriodicSchedule> = {}) =>
  ({ id: "s", tile_id: "t", workstream_id: "w", prompt: "Check CI\nthen report", notify_inbox: false, notify_phone: false, ...over }) as PeriodicSchedule;
const run = (over: Partial<PeriodicRun> = {}): PeriodicRun => ({
  id: "r", schedule_id: "s", tile_id: "t", kind: "scheduled", status: "ok", started_at: 1, ended_at: 2, exit_code: 0,
  prompt: "Check CI", answer: "All green", question: null, error: null, tools: [], events_path: null, ...over,
});

describe("delivering a run's result (ADR 046, US-6)", () => {
  it("with both toggles off, an ok run posts nothing", async () => {
    const env = setup();
    await deliverRunResult(env.deps, schedule(), run(), false, 5);
    expect([env.inbox, env.phone]).toEqual([[], []]);
  });

  it("with the toggles on, posts the answer to the Inbox and the phone thread", async () => {
    const env = setup();
    await deliverRunResult(env.deps, schedule({ notify_inbox: true, notify_phone: true }), run(), false, 5);
    expect(env.inbox).toEqual([{ tile: "t", level: "done", title: "Check CI", body: "All green" }]);
    expect(env.phone).toEqual([{ tile: "t", kind: "result", text: "All green" }]);
  });

  it("never posts to the phone while the companion is off", async () => {
    const env = setup(false);
    await deliverRunResult(env.deps, schedule({ notify_phone: true }), run(), false, 5);
    await deliverRunResult(env.deps, schedule(), run({ kind: "phone" }), false, 5);
    expect(env.phone).toEqual([]);
  });

  it("failed, timed-out and needs-input runs always reach the Inbox; an auto-pause's alert stands for its failure", async () => {
    const env = setup();
    await deliverRunResult(env.deps, schedule(), run({ status: "needs_input", answer: "NEEDS INPUT: Which?", question: "Which?" }), false, 5);
    await deliverRunResult(env.deps, schedule(), run({ status: "failed", answer: null, error: "exit code 1" }), false, 5);
    await deliverRunResult(env.deps, schedule(), run({ status: "timed_out", answer: null, error: "60 minutes" }), false, 5);
    await deliverRunResult(env.deps, schedule(), run({ status: "failed", error: "third" }), true, 5);
    await deliverRunResult(env.deps, schedule(), run({ status: "interrupted" }), false, 5);
    expect(env.inbox.map((m) => [m.level, m.title, m.body])).toEqual([
      ["needs-you", "Needs input: Check CI", "Which?"],
      ["error", "Run failed: Check CI", "exit code 1"],
      ["error", "Run timed out: Check CI", "60 minutes"],
    ]);
  });

  it("a phone reply's answer always goes back to the phone thread", async () => {
    const env = setup();
    await deliverRunResult(env.deps, schedule(), run({ kind: "phone", answer: "Checked again" }), false, 5);
    await deliverRunResult(env.deps, schedule(), run({ kind: "phone", status: "failed", answer: null, error: "exit code 2" }), false, 5);
    expect(env.phone.map((m) => m.text)).toEqual(["Checked again", "The run failed: exit code 2"]);
  });

  it("records the prompt in the phone thread before a run with Notify my phone on", async () => {
    const env = setup();
    await recordRunPrompt(env.deps, schedule({ notify_phone: true }), run({ prompt: "Check CI" }), 5);
    await recordRunPrompt(env.deps, schedule(), run(), 5);
    await recordRunPrompt(env.deps, schedule({ notify_phone: true }), run({ kind: "phone" }), 5);
    expect(env.phone).toEqual([{ tile: "t", kind: "prompt", text: "Check CI" }]);
  });

  it("clips what it posts to the stores' limits", async () => {
    const env = setup();
    await deliverRunResult(env.deps, schedule({ prompt: "x".repeat(300), notify_inbox: true, notify_phone: true }), run({ answer: "y".repeat(30_000) }), false, 5);
    expect([...env.inbox[0].title].length).toBeLessThanOrEqual(120);
    expect([...env.inbox[0].body].length).toBeLessThanOrEqual(20_000);
    expect([...env.phone[0].text].length).toBeLessThanOrEqual(20_000);
  });
});
