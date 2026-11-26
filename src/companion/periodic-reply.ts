/**
 * A phone message to a Periodic session tile (ADR 046, US-6): it is recorded
 * in the tile's phone thread and runs as the session's next headless turn,
 * whose answer the run's delivery posts back to the thread.
 */
import type { PeriodicRunKind, PeriodicSchedule } from "../domain/periodic-schedules";
import { linkRevision } from "./link-revision";
import { periodicLink } from "./publisher";

export interface PeriodicReplyDeps {
  postApp(tileId: string, workstreamId: string, kind: "prompt" | "result", text: string, at: number): Promise<void>;
  reply(scheduleId: string, text: string, kind: PeriodicRunKind): Promise<unknown>;
  /** The phone threads changed: republish them. */
  onRecorded(): void;
}

export async function replyToPeriodicSession(
  deps: PeriodicReplyDeps,
  schedule: PeriodicSchedule,
  target: { workstreamId: string; tileId: string; linkRevision: string; prompt: string },
  guard: () => void,
  now: number,
): Promise<void> {
  if ((await linkRevision(target.tileId, periodicLink(target.tileId))) !== target.linkRevision) {
    throw new Error("That periodic session is no longer the one the phone saw.");
  }
  guard();
  await deps.postApp(target.tileId, schedule.workstream_id, "prompt", target.prompt, now);
  deps.onRecorded();
  await deps.reply(schedule.id, target.prompt, "phone");
}
