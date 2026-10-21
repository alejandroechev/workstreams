import type { CompanionDoc } from "./doc";
import {
  isKnownSchema,
  PRESENCE_INTERVAL_MS,
  sessionTitle,
  signSession,
  type PhoneSession,
  type PublishedSessionTile,
  type PublishedLane,
  type PublishedWorkstream,
} from "./protocol";
import type { CompanionStoredSession } from "../backend/types";
import { compareNames, groupByLane, type WorkLane } from "../domain/work-lanes";
import type { Tile, Workstream } from "../domain/types";
import { linkRevision } from "./link-revision";

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

/**
 * The published form of the laptop's phone-session records (ADR 033), signed
 * with the pairing secret so the phone can tell them from anything else a
 * document writer put there.
 */
export async function buildSessions(
  stored: CompanionStoredSession[],
  workstreamNames: ReadonlyMap<string, string>,
  secret: string,
): Promise<Record<string, PhoneSession>> {
  const sessions: Record<string, PhoneSession> = {};
  for (const session of stored) {
    sessions[session.tileId] = await signSession(secret, {
      id: session.tileId,
      workstreamId: session.workstreamId,
      workstreamName: workstreamNames.get(session.workstreamId) ?? "Unknown workstream",
      requestId: session.requestId,
      title: sessionTitle(session.prompt),
      createdAt: session.createdAt,
      messages: session.messages.map((m) => ({ id: m.id, kind: m.kind, text: m.text, at: m.at })),
    });
  }
  return sessions;
}

const canonical = (sessions: Record<string, PhoneSession> | undefined) =>
  JSON.stringify(Object.keys(sessions ?? {}).sort().map((id) => sessions![id]));

const header = (session: PhoneSession) =>
  JSON.stringify([session.id, session.workstreamId, session.workstreamName, session.requestId, session.title, session.createdAt, session.signature]);

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

/**
 * Every Copilot session tile the phone may message (companion conversations),
 * in the sidebar's workstream order. Only what identifies a session and says
 * whether it can be resumed: no transcript, and no Copilot session id — the
 * phone gets an opaque link revision instead.
 */
export async function buildSessionTiles(input: {
  workstreams: Workstream[];
  tilesByWorkstream: ReadonlyMap<string, Tile[]>;
  stored: CompanionStoredSession[];
}): Promise<PublishedSessionTile[]> {
  const byTile = new Map(input.stored.map((s) => [s.tileId, s]));
  const out: PublishedSessionTile[] = [];
  for (const workstream of input.workstreams) {
    if (workstream.status === "archived") continue;
    for (const tile of input.tilesByWorkstream.get(workstream.id) ?? []) {
      if (tile.tile_type !== "copilot_session") continue;
      const config = (() => {
        try { return JSON.parse(tile.config_json || "{}") as Record<string, unknown>; } catch { return {}; }
      })();
      const sessionId = (config.copilot_session_id || config.resume_by_id || null) as string | null;
      const summary = typeof config.session_name === "string" && config.session_name.trim() ? config.session_name : null;
      const stored = byTile.get(tile.id);
      const updated = Date.parse(tile.updated_at);
      const activity = [Number.isFinite(updated) ? updated : null, stored ? Math.max(stored.createdAt, ...stored.messages.map((m) => m.at)) : null]
        .filter((v): v is number => v !== null);
      out.push({
        tileId: tile.id,
        workstreamId: workstream.id,
        title: tile.title || "Copilot session",
        summary,
        linked: sessionId !== null,
        linkRevision: sessionId ? await linkRevision(tile.id, sessionId) : null,
        lastActivity: activity.length > 0 ? Math.max(...activity) : null,
        origin: stored?.canSend ? "phone" : "laptop",
      });
    }
  }
  return out;
}

/** Writes the session tiles if they differ from what is published. Returns whether it wrote. */
export function publishSessionTiles(doc: CompanionDoc, tiles: PublishedSessionTile[]): boolean {
  const snapshot = doc.read();
  if (!isKnownSchema(snapshot)) return false;
  if (JSON.stringify(snapshot.laptop.tiles ?? null) === JSON.stringify(tiles)) return false;
  doc.change((draft) => {
    if (isKnownSchema(draft)) draft.laptop.tiles = JSON.parse(JSON.stringify(tiles)) as PublishedSessionTile[];
  });
  return true;
}
