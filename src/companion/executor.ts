import {
  checkRequest,
  rejectMessage,
  SCHEMA_VERSION,
  type CompanionDocument,
  type CompanionRequest,
  type CreateArgs,
  type LoadArgs,
  type SessionArgs,
} from "./protocol";

/**
 * The laptop's request executor, as a pure planner (ADR 033). It decides
 * whether a request may run and what it does; carrying the actions out is the
 * caller's job. Keeping it pure is what makes the security rules (signature,
 * freshness, once-only, schema) testable without Automerge or the app.
 */

/** What the executor needs to know about the app, resolved by the caller. */
export interface ExecutorWorld {
  workstreams: Array<{
    id: string;
    name: string;
    archived: boolean;
    loaded: boolean;
    /** The Copilot command a new session in this workstream would run. */
    copilotCommand: string;
  }>;
  /** For workstreams created by the phone, which have no repo. */
  globalCopilotCommand: string;
}

/** Refers to the workstream a `create` action made earlier in the same plan. */
export const CREATED = "$created";

export type Action =
  | { type: "create"; name: string; folderSlug: string }
  | { type: "load"; workstreamId: string }
  | { type: "session"; workstreamId: string; command: string; prompt: string };

export type Plan = { ok: true; actions: Action[] } | { ok: false; error: string };

/** Finished requests are deleted after this, to bound document history. */
export const PRUNE_AFTER_MS = 3 * 24 * 60 * 60_000;

export async function planRequest(
  request: CompanionRequest,
  world: ExecutorWorld,
  options: { secret: string; now: number; schemaVersion: unknown },
): Promise<Plan> {
  if (options.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, error: "The companion document is from a newer version. Update Workstreams." };
  }
  const check = await checkRequest(request, { secret: options.secret, now: options.now });
  if (!check.ok) return { ok: false, error: rejectMessage(check.reason) };

  const find = (id: string) => world.workstreams.find((w) => w.id === id);
  type Known = ExecutorWorld["workstreams"][number];
  const usable = (id: string): { ok: true; workstream: Known } | { ok: false; error: string } => {
    const workstream = find(id);
    if (!workstream) return { ok: false, error: "That workstream was not found on the laptop." };
    if (workstream.archived) return { ok: false, error: "That workstream is archived." };
    return { ok: true, workstream };
  };

  switch (request.kind) {
    case "load": {
      const target = usable((request.args as LoadArgs).workstreamId);
      if (!target.ok) return { ok: false, error: target.error };
      return { ok: true, actions: target.workstream.loaded ? [] : [{ type: "load", workstreamId: target.workstream.id }] };
    }
    case "create": {
      const { name, prompt } = request.args as CreateArgs;
      const trimmed = name.trim();
      const actions: Action[] = [
        { type: "create", name: trimmed, folderSlug: folderSlug(trimmed) },
        { type: "load", workstreamId: CREATED },
      ];
      if (prompt && prompt.trim()) {
        actions.push({ type: "session", workstreamId: CREATED, command: world.globalCopilotCommand, prompt });
      }
      return { ok: true, actions };
    }
    case "session": {
      const { workstreamId, prompt } = request.args as SessionArgs;
      const target = usable(workstreamId);
      if (!target.ok) return { ok: false, error: target.error };
      const actions: Action[] = target.workstream.loaded ? [] : [{ type: "load", workstreamId }];
      actions.push({ type: "session", workstreamId, command: target.workstream.copilotCommand, prompt });
      return { ok: true, actions };
    }
  }
}

const isEntry = (value: unknown): value is CompanionRequest =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Keys of inbox entries that are not even objects. Anyone with the document
 * URL can write them; they carry no request and cannot hold an outcome.
 */
export function garbageEntries(doc: CompanionDocument): string[] {
  return Object.entries(doc.requests ?? {}).filter(([, value]) => !isEntry(value)).map(([key]) => key);
}

/** Inbox entries nobody has handled yet, oldest first, with their map keys. */
export function pendingEntries(doc: CompanionDocument): Array<[string, CompanionRequest]> {
  const createdAt = (request: CompanionRequest) => (typeof request.createdAt === "number" ? request.createdAt : 0);
  return Object.entries(doc.requests ?? {})
    .filter((entry): entry is [string, CompanionRequest] => isEntry(entry[1]) && !entry[1].outcome)
    .sort(([, a], [, b]) => createdAt(a) - createdAt(b));
}

/** Requests nobody has handled yet, oldest first. */
export function pendingRequests(doc: CompanionDocument): CompanionRequest[] {
  return pendingEntries(doc).map(([, request]) => request);
}

/**
 * Requests a previous run marked `running` and never finished: the app died
 * mid-action. They are failed, never retried, because the action may have
 * happened. Returned as map keys.
 */
export function interruptedRequests(doc: CompanionDocument): string[] {
  return Object.entries(doc.requests ?? {})
    .filter(([, request]) => isEntry(request) && request.outcome?.status === "running")
    .map(([key]) => key);
}

export function requestsToPrune(doc: CompanionDocument, now: number): string[] {
  return Object.entries(doc.requests ?? {})
    .filter(([, request]) => isEntry(request) && request.outcome && request.outcome.status !== "running"
      && typeof request.outcome.at === "number" && now - request.outcome.at > PRUNE_AFTER_MS)
    .map(([key]) => key);
}

/**
 * A folder name from a workstream name: ASCII, lowercase, dashes, ≤50 chars.
 * Never contains a path separator or dot segment, whatever the phone sent.
 */
export function folderSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Letters with no Unicode decomposition to a plain ASCII base.
    .replace(/[øœæßđłþð]/g, (c) => ({ ø: "o", œ: "oe", æ: "ae", ß: "ss", đ: "d", ł: "l", þ: "th", ð: "d" })[c] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || "workstream";
}
