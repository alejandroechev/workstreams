import type { CompanionDoc } from "./doc";
import { PRESENCE_INTERVAL_MS, type PublishedLane, type PublishedWorkstream } from "./protocol";
import { compareNames, groupByLane, type WorkLane } from "../domain/work-lanes";
import type { Workstream } from "../domain/types";

/** `laptop.lastSeenAt` is persisted this rarely, to keep document history small. */
export const LAST_SEEN_WRITE_MS = 5 * 60_000;

export interface LaptopState {
  workstreams: PublishedWorkstream[];
  lanes: PublishedLane[];
}

/**
 * The laptop half of the companion document (ADR 033): non-archived
 * workstreams in exactly the sidebar's order, flattened (the phone shows lanes
 * as tags, not groups).
 */
export function buildLaptopState(input: {
  workstreams: Workstream[];
  lanes: WorkLane[];
  loadedIds: ReadonlySet<string>;
  sessionCounts: ReadonlyMap<string, number>;
}): LaptopState {
  const knownLane = new Set(input.lanes.map((lane) => lane.id));
  const visible = input.workstreams.filter((workstream) => workstream.status !== "archived");
  const workstreams = groupByLane(visible, input.lanes)
    .flatMap((group) => group.workstreams)
    .map((workstream) => ({
      id: workstream.id,
      name: workstream.name,
      // A lane that no longer exists is shown as no lane, as in the sidebar.
      laneId: workstream.lane_id && knownLane.has(workstream.lane_id) ? workstream.lane_id : null,
      loaded: input.loadedIds.has(workstream.id),
      sessionCount: input.sessionCounts.get(workstream.id) ?? 0,
    }));
  const lanes = input.lanes
    .slice()
    .sort((left, right) => compareNames(left.name, right.name))
    .map((lane) => ({ id: lane.id, name: lane.name }));
  return { workstreams, lanes };
}

/** Writes the state if it differs from what is published. Returns whether it wrote. */
export function publishLaptopState(doc: CompanionDoc, state: LaptopState): boolean {
  const current = doc.read().laptop;
  if (JSON.stringify(current.workstreams) === JSON.stringify(state.workstreams)
    && JSON.stringify(current.lanes) === JSON.stringify(state.lanes)) {
    return false;
  }
  doc.change((draft) => {
    draft.laptop.workstreams = state.workstreams;
    draft.laptop.lanes = state.lanes;
  });
  return true;
}

/**
 * Broadcasts ephemeral presence every interval, and persists `lastSeenAt`
 * at start and then every few minutes. Returns a stop function.
 */
export function startPresence(doc: CompanionDoc): () => void {
  let lastWrite = 0;
  const tick = () => {
    const now = Date.now();
    doc.broadcast({ kind: "presence", sentAt: now });
    if (lastWrite === 0 || now - lastWrite >= LAST_SEEN_WRITE_MS) {
      lastWrite = now;
      doc.change((draft) => { draft.laptop.lastSeenAt = now; });
    }
  };
  tick();
  const timer = setInterval(tick, PRESENCE_INTERVAL_MS);
  return () => clearInterval(timer);
}
