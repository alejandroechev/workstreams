import type { CompanionDoc } from "./doc";
import {
  isKnownSchema,
  PRESENCE_INTERVAL_MS,
  sessionTitle,
  type PhoneSession,
  type PublishedLane,
  type PublishedWorkstream,
} from "./protocol";
import type { CompanionStoredSession } from "../backend/types";
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
  const snapshot = doc.read();
  // A newer version's document gets no writes at all (ADR 033).
  if (!isKnownSchema(snapshot)) return false;
  const current = snapshot.laptop;
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
    if ((lastWrite === 0 || now - lastWrite >= LAST_SEEN_WRITE_MS) && isKnownSchema(doc.read())) {
      lastWrite = now;
      doc.change((draft) => {
        // Checked inside the change: the document may have been upgraded since.
        if (isKnownSchema(draft)) draft.laptop.lastSeenAt = now;
      });
    }
  };
  tick();
  const timer = setInterval(tick, PRESENCE_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** The published form of the laptop's phone-session records (ADR 033). */
export function buildSessions(
  stored: CompanionStoredSession[],
  workstreamNames: ReadonlyMap<string, string>,
): Record<string, PhoneSession> {
  const sessions: Record<string, PhoneSession> = {};
  for (const session of stored) {
    sessions[session.tileId] = {
      id: session.tileId,
      workstreamId: session.workstreamId,
      workstreamName: workstreamNames.get(session.workstreamId) ?? "Unknown workstream",
      requestId: session.requestId,
      title: sessionTitle(session.prompt),
      createdAt: session.createdAt,
      messages: session.messages.map((m) => ({ id: m.id, kind: m.kind, text: m.text, at: m.at })),
    };
  }
  return sessions;
}

const canonical = (sessions: Record<string, PhoneSession> | undefined) =>
  JSON.stringify(Object.keys(sessions ?? {}).sort().map((id) => sessions![id]));

const header = (session: PhoneSession) =>
  JSON.stringify([session.id, session.workstreamId, session.workstreamName, session.requestId, session.title, session.createdAt]);

/**
 * Writes the sessions if they differ from what is published. Changes are made
 * in place — new messages appended, dropped ones removed — so the document's
 * history grows by what changed, not by every session each time.
 * Returns whether it wrote.
 */
export function publishSessions(doc: CompanionDoc, sessions: Record<string, PhoneSession>): boolean {
  const snapshot = doc.read();
  if (!isKnownSchema(snapshot)) return false;
  if (canonical(snapshot.sessions) === canonical(sessions)) return false;
  doc.change((draft) => {
    if (!isKnownSchema(draft)) return;
    if (!draft.sessions || typeof draft.sessions !== "object") draft.sessions = {};
    const published = draft.sessions;
    for (const id of Object.keys(published)) if (!(id in sessions)) delete published[id];
    for (const [id, session] of Object.entries(sessions)) {
      const existing = published[id];
      if (!existing || !Array.isArray(existing.messages) || header(existing) !== header(session)) {
        published[id] = JSON.parse(JSON.stringify(session)) as PhoneSession;
        continue;
      }
      const wanted = new Set(session.messages.map((m) => m.id));
      for (let i = existing.messages.length - 1; i >= 0; i -= 1) {
        if (!wanted.has(existing.messages[i]?.id)) existing.messages.splice(i, 1);
      }
      const have = new Set(existing.messages.map((m) => m.id));
      for (const message of session.messages) if (!have.has(message.id)) existing.messages.push({ ...message });
      if (JSON.stringify(existing.messages) !== JSON.stringify(session.messages)) {
        existing.messages.splice(0, existing.messages.length, ...session.messages.map((m) => ({ ...m })));
      }
    }
  });
  return true;
}
