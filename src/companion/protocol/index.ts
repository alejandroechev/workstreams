/**
 * Workstreams companion protocol (ADR 033).
 *
 * SHARED VERBATIM with the `workstreams-companion` repository: copy this file
 * and `fixtures.json` unchanged, and keep both repositories' tests passing
 * against the same fixtures. It must stay dependency-free (WebCrypto only), so
 * it runs in the Workstreams webview, the Android webview, Node and jsdom.
 */

/** Major version of the document format. Bump only for breaking changes. */
export const SCHEMA_VERSION = 1;

/** A request older than this is never executed. */
export const REQUEST_TTL_MS = 5 * 60_000;
/** How far ahead of the laptop's clock a request's timestamp may be. */
export const CLOCK_SKEW_MS = 60_000;
/** The laptop broadcasts presence this often. */
export const PRESENCE_INTERVAL_MS = 10_000;
/** The laptop counts as online if presence arrived within this window. */
export const PRESENCE_TIMEOUT_MS = 30_000;

export const MAX_NAME_LENGTH = 120;
export const MAX_PROMPT_LENGTH = 20_000;

export type RequestKind = "load" | "create" | "session";

export interface LoadArgs { workstreamId: string }
export interface CreateArgs { name: string; prompt?: string }
export interface SessionArgs { workstreamId: string; prompt: string }

export type RequestArgs = LoadArgs | CreateArgs | SessionArgs;

export interface RequestOutcome {
  status: "running" | "done" | "failed";
  /** ms epoch, laptop clock. */
  at: number;
  error?: string;
  /** For create: the id of the workstream that was made. */
  workstreamId?: string;
}

export interface CompanionRequest {
  id: string;
  kind: RequestKind;
  args: RequestArgs;
  /** ms epoch, phone clock. */
  createdAt: number;
  /** HMAC-SHA256 hex of `canonicalRequest`, keyed with the pairing secret. */
  signature: string;
  outcome?: RequestOutcome;
}

export type UnsignedRequest = Omit<CompanionRequest, "signature" | "outcome">;

export interface PublishedWorkstream {
  id: string;
  name: string;
  laneId: string | null;
  loaded: boolean;
  sessionCount: number;
}

export interface PublishedLane { id: string; name: string }

export interface CompanionDocument {
  schemaVersion: number;
  laptop: {
    workstreams: PublishedWorkstream[];
    lanes: PublishedLane[];
    /** ms epoch; written every few minutes for the "last seen" text. */
    lastSeenAt: number | null;
  };
  requests: Record<string, CompanionRequest>;
}

/** Ephemeral presence message (never stored in the document). */
export interface PresenceMessage { kind: "presence"; sentAt: number }

export function emptyDocument(): CompanionDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    laptop: { workstreams: [], lanes: [], lastSeenAt: null },
    requests: {},
  };
}

export function isKnownSchema(doc: { schemaVersion?: unknown }): boolean {
  return doc.schemaVersion === SCHEMA_VERSION;
}

// ── Shape ──────────────────────────────────────────────────────────────

const ALLOWED_ARGS: Record<RequestKind, { required: string[]; optional: string[] }> = {
  load: { required: ["workstreamId"], optional: [] },
  create: { required: ["name"], optional: ["prompt"] },
  session: { required: ["workstreamId", "prompt"], optional: [] },
};

export type ParseResult = { ok: true; request: UnsignedRequest } | { ok: false; reason: string };

/** Validates the shape of an untrusted request; never trusts the document. */
export function parseRequest(raw: unknown): ParseResult {
  const fail = (reason: string): ParseResult => ({ ok: false, reason });
  if (!raw || typeof raw !== "object") return fail("not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 100) return fail("bad id");
  if (typeof r.kind !== "string" || !(r.kind in ALLOWED_ARGS)) return fail("unknown kind");
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return fail("bad createdAt");
  if (!r.args || typeof r.args !== "object" || Array.isArray(r.args)) return fail("bad args");
  const kind = r.kind as RequestKind;
  const args = r.args as Record<string, unknown>;
  const { required, optional } = ALLOWED_ARGS[kind];
  for (const key of Object.keys(args)) {
    if (args[key] === undefined) continue;
    if (!required.includes(key) && !optional.includes(key)) return fail(`unexpected argument ${key}`);
    if (typeof args[key] !== "string") return fail(`${key} must be text`);
  }
  for (const key of required) {
    if (typeof args[key] !== "string" || (args[key] as string).trim() === "") return fail(`missing ${key}`);
  }
  if (typeof args.name === "string" && args.name.trim().length > MAX_NAME_LENGTH) return fail("name too long");
  if (typeof args.prompt === "string" && args.prompt.length > MAX_PROMPT_LENGTH) return fail("prompt too long");
  return {
    ok: true,
    request: { id: r.id, kind, args: args as unknown as RequestArgs, createdAt: r.createdAt },
  };
}

// ── Canonical form and signing ─────────────────────────────────────────

function sortedArgs(args: RequestArgs): Record<string, string> {
  const source = args as unknown as Record<string, string | undefined>;
  const out: Record<string, string> = {};
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The exact bytes that are signed: version, id, kind, sorted args, time. */
export function canonicalRequest(request: UnsignedRequest): string {
  return JSON.stringify([SCHEMA_VERSION, request.id, request.kind, sortedArgs(request.args), request.createdAt]);
}

function base64urlDecode(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const raw = base64urlDecode(secret);
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signRequest(secret: string, request: UnsignedRequest): Promise<string> {
  const key = await hmacKey(secret);
  return hex(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalRequest(request))));
}

/** Compares without exiting early, so timing does not reveal a prefix match. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── The gate every request passes before it is executed ────────────────

export type RejectReason =
  | "invalid"
  | "not-paired"
  | "unsigned"
  | "bad-signature"
  | "expired"
  | "from-the-future"
  | "already-handled";

export type CheckResult = { ok: true } | { ok: false; reason: RejectReason };

export function isFresh(createdAt: number, now: number): boolean {
  return now - createdAt <= REQUEST_TTL_MS && createdAt - now <= CLOCK_SKEW_MS;
}

/**
 * Whether the laptop may execute this request now. Order matters: a request
 * that already has an outcome is never re-examined, and shape is checked
 * before the signature so nothing malformed reaches the HMAC.
 */
export async function checkRequest(
  request: CompanionRequest,
  options: { secret: string; now: number },
): Promise<CheckResult> {
  const reject = (reason: RejectReason): CheckResult => ({ ok: false, reason });
  if (request?.outcome) return reject("already-handled");
  const parsed = parseRequest(request);
  if (!parsed.ok) return reject("invalid");
  if (!options.secret) return reject("not-paired");
  if (typeof request.signature !== "string" || request.signature === "") return reject("unsigned");
  const expected = await signRequest(options.secret, parsed.request);
  if (!constantTimeEqual(expected, request.signature)) return reject("bad-signature");
  if (options.now - parsed.request.createdAt > REQUEST_TTL_MS) return reject("expired");
  if (parsed.request.createdAt - options.now > CLOCK_SKEW_MS) return reject("from-the-future");
  return { ok: true };
}

/** Human-readable text for a rejection, written into the request's outcome. */
export function rejectMessage(reason: RejectReason): string {
  switch (reason) {
    case "invalid": return "The request was malformed.";
    case "not-paired": return "Workstreams has no paired phone. Pair again from its settings.";
    case "unsigned": return "The request was not signed.";
    case "bad-signature": return "The request was not signed by the paired phone. Pair again.";
    case "expired": return "The request is too old; Workstreams was not reachable in time.";
    case "from-the-future": return "The phone's clock is ahead of the laptop's. Check the date and time.";
    case "already-handled": return "The request was already handled.";
  }
}

// ── Presence ───────────────────────────────────────────────────────────

export function isLaptopOnline(lastPresenceAt: number | null, now: number): boolean {
  return lastPresenceAt !== null && now - lastPresenceAt <= PRESENCE_TIMEOUT_MS;
}

// ── Lane colours (derived, never stored) ───────────────────────────────

/**
 * The Workstreams sidebar's lane palette and hash, copied exactly
 * (`src/domain/work-lanes.ts`), so a lane is the same colour on both screens.
 * A test in the Workstreams repo pins the two together.
 */
export const LANE_COLORS = ["#89b4fa", "#a6e3a1", "#f9e2af", "#cba6f7", "#fab387", "#f38ba8"] as const;
/** Colour for a workstream with no lane. */
export const NO_LANE_COLOR = "#45475a";

export function laneColor(laneId: string | null | undefined): string {
  if (!laneId) return NO_LANE_COLOR;
  let hash = 0;
  for (let index = 0; index < laneId.length; index += 1) {
    hash = (hash << 5) - hash + laneId.charCodeAt(index);
    hash |= 0;
  }
  return LANE_COLORS[Math.abs(hash) % LANE_COLORS.length];
}

// ── Pairing ────────────────────────────────────────────────────────────

export interface Pairing { doc: string; secret: string }

export function generateSecret(): string {
  return base64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** The QR code payload. */
export function encodePairing(pairing: Pairing): string {
  return JSON.stringify({ v: 1, doc: pairing.doc, secret: pairing.secret });
}

export function decodePairing(text: string): Pairing | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed?.v !== 1) return null;
    if (typeof parsed.doc !== "string" || !/^automerge:[1-9A-HJ-NP-Za-km-z]+$/.test(parsed.doc)) return null;
    if (typeof parsed.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.secret)) return null;
    return { doc: parsed.doc, secret: parsed.secret };
  } catch {
    return null;
  }
}
