import { afterAll, describe, expect, it } from "vitest";
import {
  applyRunResult,
  composeRunPrompt,
  decideDue,
  describeFrequency,
  describeLastResult,
  formatNextRun,
  frequencyMinutes,
  INBOX_INSTRUCTION,
  MAX_CONSECUTIVE_FAILURES,
  nextRunAfter,
  PHONE_INSTRUCTION,
  promptFirstLine,
  validateFrequency,
  type PeriodicSchedule,
} from "../periodic-schedules";

// DST cases need a zone with a change; Santiago springs forward at midnight.
const originalTz = process.env.TZ;
process.env.TZ = "America/Santiago";
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

function schedule(overrides: Partial<PeriodicSchedule> = {}): PeriodicSchedule {
  return {
    id: "s1",
    tile_id: "t1",
    workstream_id: "w1",
    prompt: "Check for new videos",
    frequency: { kind: "daily", time: "09:00" },
    notify_inbox: false,
    notify_phone: false,
    paused: false,
    next_run_at: null,
    last_run_at: null,
    last_result: null,
    last_error: null,
    failures: 0,
    run_requested: false,
    created_at: 0,
    ...overrides,
  };
}

describe("validateFrequency", () => {
  it("accepts every preset at or above five minutes", () => {
    expect(validateFrequency({ kind: "interval", minutes: 60 })).toBeNull();
    expect(validateFrequency({ kind: "interval", minutes: 5 })).toBeNull();
    expect(validateFrequency({ kind: "daily", time: "09:00" })).toBeNull();
    expect(validateFrequency({ kind: "weekly", day: 1, time: "23:59" })).toBeNull();
  });

  it("refuses anything more frequent than every 5 minutes, naming the minimum", () => {
    expect(validateFrequency({ kind: "interval", minutes: 1 })).toMatch(/5 minutes/);
    expect(validateFrequency({ kind: "interval", minutes: 4.5 })).toMatch(/5 minutes/);
  });

  it("refuses malformed times, days and intervals", () => {
    expect(validateFrequency({ kind: "daily", time: "9am" })).toMatch(/HH:MM/);
    expect(validateFrequency({ kind: "daily", time: "24:00" })).toMatch(/HH:MM/);
    expect(validateFrequency({ kind: "weekly", day: 7, time: "09:00" })).toMatch(/day/);
    expect(validateFrequency({ kind: "interval", minutes: Number.NaN })).toMatch(/whole number/);
    expect(validateFrequency({ kind: "interval", minutes: 7.5 })).toMatch(/whole number/);
    expect(validateFrequency({ kind: "monthly" } as never)).toMatch(/Unknown/);
  });
});

describe("nextRunAfter", () => {
  it("runs daily at the next HH:MM strictly after now", () => {
    const freq = { kind: "daily", time: "09:00" } as const;
    expect(nextRunAfter(freq, 0, at(2026, 11, 23, 8, 0))).toBe(at(2026, 11, 23, 9, 0));
    expect(nextRunAfter(freq, 0, at(2026, 11, 23, 9, 0))).toBe(at(2026, 11, 24, 9, 0));
    expect(nextRunAfter(freq, 0, at(2026, 11, 23, 16, 42))).toBe(at(2026, 11, 24, 9, 0));
  });

  it("runs weekly on the given day (0 = Sunday)", () => {
    const freq = { kind: "weekly", day: 1, time: "10:30" } as const; // Monday
    // 2026-11-23 is a Monday.
    expect(nextRunAfter(freq, 0, at(2026, 11, 23, 10, 0))).toBe(at(2026, 11, 23, 10, 30));
    expect(nextRunAfter(freq, 0, at(2026, 11, 23, 11, 0))).toBe(at(2026, 11, 30, 10, 30));
    expect(nextRunAfter(freq, 0, at(2026, 11, 25, 9, 0))).toBe(at(2026, 11, 30, 10, 30));
  });

  it("runs intervals on the series anchored at the anchor, skipping missed slots", () => {
    const freq = { kind: "interval", minutes: 120 } as const;
    const anchor = at(2026, 11, 23, 8, 0);
    expect(nextRunAfter(freq, anchor, anchor)).toBe(at(2026, 11, 23, 10, 0));
    expect(nextRunAfter(freq, anchor, at(2026, 11, 23, 10, 0))).toBe(at(2026, 11, 23, 12, 0));
    // Asleep from 10:30 to 17:10: the next slot after waking, no catch-up.
    expect(nextRunAfter(freq, anchor, at(2026, 11, 23, 17, 10))).toBe(at(2026, 11, 23, 18, 0));
    // An anchor in the future (clock moved back) still yields the first slot after now.
    expect(nextRunAfter(freq, at(2026, 11, 24, 0, 0), anchor)).toBe(at(2026, 11, 23, 10, 0));
  });

  it("follows DST: daily 09:00 stays 09:00 local across a change (America/Santiago)", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const freq = { kind: "daily", time: "09:00" } as const;
    // Chile springs forward on the first Sunday of September (2026-09-06, 00:00 → 01:00).
    const before = at(2026, 9, 5, 10, 0);
    const run = nextRunAfter(freq, 0, before);
    const local = new Date(run);
    expect([local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes()])
      .toEqual([2026, 9, 6, 9, 0]);
    expect(zone).toBe("America/Santiago");
    {
      // 23 hours after the previous day's 09:00, not 24.
      expect(run - at(2026, 9, 5, 9, 0)).toBe(23 * 60 * 60 * 1000);
    }
  });
});

describe("decideDue", () => {
  const due = at(2026, 11, 23, 9, 0);

  it("waits until the due time", () => {
    expect(decideDue(schedule({ next_run_at: due }), { now: due - 1, busy: false })).toEqual({ action: "wait" });
  });

  it("asks for a next run when none is set", () => {
    expect(decideDue(schedule(), { now: due, busy: false })).toEqual({ action: "plan" });
  });

  it("runs when due and idle, even if the user typed recently", () => {
    expect(decideDue(schedule({ next_run_at: due }), { now: due + 1000, busy: false })).toEqual({ action: "run", manual: false });
  });

  it("skips a run due while the agent is mid-turn", () => {
    expect(decideDue(schedule({ next_run_at: due }), { now: due + 1000, busy: true })).toEqual({ action: "skip" });
  });

  it("treats a run long overdue (app closed, laptop asleep) as missed, never caught up", () => {
    expect(decideDue(schedule({ next_run_at: due }), { now: due + 60 * 60 * 1000, busy: false })).toEqual({ action: "missed" });
  });

  it("never runs a paused schedule, even when due or requested", () => {
    expect(decideDue(schedule({ next_run_at: due, paused: true }), { now: due, busy: false })).toEqual({ action: "wait" });
    expect(decideDue(schedule({ run_requested: true, paused: true }), { now: due, busy: false })).toEqual({ action: "wait" });
  });

  it("runs now when asked, unless mid-turn", () => {
    expect(decideDue(schedule({ run_requested: true, next_run_at: due + 999_999 }), { now: due, busy: false })).toEqual({ action: "run", manual: true });
    expect(decideDue(schedule({ run_requested: true }), { now: due, busy: true })).toEqual({ action: "skip", manual: true });
  });
});

describe("applyRunResult", () => {
  const now = at(2026, 11, 23, 9, 0);

  it("resets failures on success", () => {
    const { patch, autoPaused } = applyRunResult(schedule({ failures: 2 }), { result: "ok" }, now);
    expect(patch).toMatchObject({ last_result: "ok", failures: 0, last_error: null });
    expect(autoPaused).toBe(false);
  });

  it("records a skip without counting it as a failure", () => {
    const { patch } = applyRunResult(schedule({ failures: 2 }), { result: "skipped" }, now);
    expect(patch).toMatchObject({ last_result: "skipped" });
    expect(patch.failures).toBeUndefined();
    expect(patch.paused).toBeUndefined();
  });

  it("counts could-not-start and timed-out, and pauses after 3 in a row", () => {
    let s = schedule();
    const first = applyRunResult(s, { result: "could not start", error: "not linked" }, now);
    expect(first.patch).toMatchObject({ failures: 1, last_error: "not linked" });
    s = { ...s, ...first.patch };
    const second = applyRunResult(s, { result: "timed out" }, now);
    s = { ...s, ...second.patch };
    expect(second.autoPaused).toBe(false);
    const third = applyRunResult(s, { result: "could not start", error: "tile gone" }, now);
    expect(third.patch).toMatchObject({ failures: MAX_CONSECUTIVE_FAILURES, paused: true });
    expect(third.autoPaused).toBe(true);
  });

  it("does not re-announce a pause on a schedule already paused", () => {
    const { autoPaused } = applyRunResult(schedule({ failures: 5, paused: true }), { result: "timed out" }, now);
    expect(autoPaused).toBe(false);
  });
});

describe("composeRunPrompt", () => {
  it("sends the prompt verbatim with both toggles off", () => {
    const prompt = "  Check  the course\n\tfor new videos  ";
    expect(composeRunPrompt({ prompt, notify_inbox: false, notify_phone: false })).toBe(prompt);
  });

  it("appends the ws-message instruction for the Inbox", () => {
    const out = composeRunPrompt({ prompt: "P", notify_inbox: true, notify_phone: false });
    expect(out.startsWith("P\n\n")).toBe(true);
    expect(out).toContain(INBOX_INSTRUCTION);
    expect(INBOX_INSTRUCTION).toContain("ws-message");
    expect(out).not.toContain("companion-reply");
  });

  it("appends the companion-reply instruction for the phone", () => {
    const out = composeRunPrompt({ prompt: "P", notify_inbox: false, notify_phone: true });
    expect(out).toBe(`P\n\n${PHONE_INSTRUCTION}`);
    expect(PHONE_INSTRUCTION).toContain("companion-reply");
  });

  it("appends both when both are on", () => {
    expect(composeRunPrompt({ prompt: "P", notify_inbox: true, notify_phone: true })).toBe(`P\n\n${INBOX_INSTRUCTION}\n${PHONE_INSTRUCTION}`);
  });
});

describe("descriptions", () => {
  it("describes each preset", () => {
    expect(describeFrequency({ kind: "interval", minutes: 60 })).toBe("Hourly");
    expect(describeFrequency({ kind: "interval", minutes: 120 })).toBe("Every 2 hours");
    expect(describeFrequency({ kind: "interval", minutes: 30 })).toBe("Every 30 minutes");
    expect(describeFrequency({ kind: "interval", minutes: 90 })).toBe("Every 90 minutes");
    expect(describeFrequency({ kind: "daily", time: "09:00" })).toBe("Daily at 09:00");
    expect(describeFrequency({ kind: "weekly", day: 1, time: "09:00" })).toBe("Weekly on Monday at 09:00");
  });

  it("gives the interval in minutes, null for calendar presets", () => {
    expect(frequencyMinutes({ kind: "interval", minutes: 120 })).toBe(120);
    expect(frequencyMinutes({ kind: "daily", time: "09:00" })).toBeNull();
  });

  it("formats the next run relative to today", () => {
    const now = at(2026, 11, 23, 16, 0);
    expect(formatNextRun(at(2026, 11, 23, 18, 5), now)).toBe("today 18:05");
    expect(formatNextRun(at(2026, 11, 24, 9, 0), now)).toBe("tomorrow 09:00");
    expect(formatNextRun(at(2026, 11, 30, 9, 0), now)).toMatch(/^Mon 30 Nov 09:00$/);
    expect(formatNextRun(null, now)).toBe("not planned");
  });

  it("describes the last result", () => {
    expect(describeLastResult(schedule())).toBe("never run");
    expect(describeLastResult(schedule({ last_result: "ok" }))).toBe("ok");
    expect(describeLastResult(schedule({ last_result: "could not start", last_error: "tile gone" }))).toBe("could not start: tile gone");
  });

  it("takes the prompt's first non-empty line", () => {
    expect(promptFirstLine("\n  Check videos \nthen summarise")).toBe("Check videos");
    expect(promptFirstLine("   ")).toBe("");
  });
});
