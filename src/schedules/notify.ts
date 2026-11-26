/**
 * Delivers a periodic run's result (ADR 046, US-6): Workstreams posts it
 * itself, so it doesn't depend on the agent remembering to.
 *
 * - An ok run posts its final answer to the Inbox with Notify in Inbox on.
 * - Needs-input, failed and timed-out runs always post to the Inbox (an
 *   auto-pause's own alert stands for the failure that caused it).
 * - With Notify my phone on and the companion on, the run's prompt and its
 *   answer go to the tile's phone thread; a run the phone asked for always
 *   answers there.
 *
 * Inbox posts go through the app's Inbox path, so the mute gate (ADR 045) applies.
 */
import { promptFirstLine, type PeriodicRun, type PeriodicSchedule } from "../domain/periodic-schedules";

export interface NotifyDeps {
  postInbox(workstreamId: string, tileId: string, level: "done" | "needs-you" | "error", title: string, body: string): Promise<void>;
  postPhone(tileId: string, workstreamId: string, kind: "prompt" | "result", text: string, at: number): Promise<void>;
  companionOn(): Promise<boolean>;
}

const MAX_TITLE = 120;
const MAX_TEXT = 20_000;
const clip = (text: string, max: number) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

function inboxEntry(schedule: PeriodicSchedule, run: PeriodicRun, autoPaused: boolean): { level: "done" | "needs-you" | "error"; title: string; body: string } | null {
  const name = promptFirstLine(schedule.prompt) || "Periodic session";
  switch (run.status) {
    case "ok":
      return schedule.notify_inbox ? { level: "done", title: name, body: run.answer ?? "The run ended without an answer." } : null;
    case "needs_input":
      return { level: "needs-you", title: `Needs input: ${name}`, body: run.question || run.answer || "" };
    case "failed":
      return autoPaused ? null : { level: "error", title: `Run failed: ${name}`, body: run.error ?? "The run failed." };
    case "timed_out":
      return autoPaused ? null : { level: "error", title: `Run timed out: ${name}`, body: run.error ?? "" };
    default:
      return null;
  }
}

function phoneText(run: PeriodicRun): string | null {
  if (run.answer?.trim()) return run.answer;
  if (run.status === "failed" || run.status === "timed_out") return `The run ${run.status === "failed" ? "failed" : "timed out"}: ${run.error ?? ""}`.trim();
  return null;
}

async function phoneWanted(deps: NotifyDeps, schedule: PeriodicSchedule, run: PeriodicRun): Promise<boolean> {
  if (run.kind !== "phone" && !schedule.notify_phone) return false;
  return deps.companionOn().catch(() => false);
}

export async function deliverRunResult(deps: NotifyDeps, schedule: PeriodicSchedule, run: PeriodicRun, autoPaused: boolean, now: number): Promise<void> {
  const entry = inboxEntry(schedule, run, autoPaused);
  if (entry) {
    await deps.postInbox(schedule.workstream_id, schedule.tile_id, entry.level, clip(entry.title, MAX_TITLE), clip(entry.body, MAX_TEXT))
      .catch((error) => console.error("Failed to post a periodic run to the Inbox:", error));
  }
  const text = phoneText(run);
  if (text && (run.status !== "skipped" && run.status !== "interrupted") && (await phoneWanted(deps, schedule, run))) {
    await deps.postPhone(schedule.tile_id, schedule.workstream_id, "result", clip(text, MAX_TEXT), now)
      .catch((error) => console.error("Failed to post a periodic run to the phone:", error));
  }
}

/** The run's prompt, in the phone thread, before its answer (Notify my phone; a phone reply records its own). */
export async function recordRunPrompt(deps: NotifyDeps, schedule: PeriodicSchedule, run: PeriodicRun, now: number): Promise<void> {
  if (run.kind === "phone" || !(await phoneWanted(deps, schedule, run))) return;
  await deps.postPhone(schedule.tile_id, schedule.workstream_id, "prompt", clip(run.prompt, MAX_TEXT), now)
    .catch((error) => console.error("Failed to post a periodic run's prompt to the phone:", error));
}
