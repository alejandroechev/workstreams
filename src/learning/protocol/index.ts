/**
 * The Rust Pocket learning protocol (ADR 042, relay amendment). Kept
 * byte-compatible with rust-pocket's `src/domain/protocol.ts`: both sign the
 * same canonical JSON (keys sorted) with HMAC-SHA256 under the learning key,
 * and both test against `fixtures.json`, which the phone's own code produced.
 *
 * The learning key is 64 hex characters; the companion's is base64url. Each
 * service verifies only with its own key, so a request signed for one is
 * refused by the other.
 */

export const SCHEMA_VERSION = 1;
export const REQUEST_TTL_MS = 5 * 60_000;
export const CLOCK_SKEW_MS = 60_000;
export const MAX_SOURCE = 20_000;
export const MAX_CONTEXT = 16_000;
export const MAX_ENVELOPE = 200_000;

export interface LearningRequest {
  version: 1;
  id: string;
  kind: "check" | "help";
  createdAt: number;
  cardId: string;
  cardVersion: string;
  source: string;
  /** Check: the card's harness, as the phone has it (B4). */
  harness?: Record<string, unknown>;
  toolchain?: string;
  /** Help only. */
  level?: "nudge" | "hint" | "solution";
  exercise?: Record<string, unknown>;
  summary?: string;
  diagnostic?: string;
}

export interface LearningResponse {
  version: 1;
  id: string;
  /** Binds the result to the exact request it answers. */
  requestHash: string;
  at: number;
  result?: unknown;
  reply?: string;
  error?: string;
}

export interface Envelope<T> { body: T; signature: string }

/** The shared learning document: the phone writes requests, Workstreams results. */
export interface LearningDocument {
  schemaVersion: number;
  /** id → JSON `Envelope<LearningRequest>`. */
  requests: Record<string, string>;
  /** id → JSON `Envelope<LearningResponse>`, or `{"refused": reason}` unsigned. */
  results: Record<string, string>;
  laptop?: { lastSeenAt: number };
}

export function emptyLearningDocument(): LearningDocument {
  return { schemaVersion: SCHEMA_VERSION, requests: {}, results: {} };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const record = value as Record<string, unknown>;
  // Like JSON, an undefined field is absent: it must not change the signature.
  return "{" + Object.keys(record).filter((k) => record[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(record[k])).join(",") + "}";
}

const encode = (value: unknown) => new TextEncoder().encode(canonical(value));
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) => new Uint8Array(text.match(/../g)!.map((h) => parseInt(h, 16)));
const HEX_KEY = /^[a-f0-9]{64}$/i;

async function hmacKey(secret: string) {
  if (!HEX_KEY.test(secret)) throw new Error("The learning key must be 64 hexadecimal characters");
  return crypto.subtle.importKey("raw", fromHex(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign<T>(body: T, secret: string): Promise<Envelope<T>> {
  return { body, signature: hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), encode(body))) };
}

export async function verify<T>(envelope: Envelope<T>, secret: string): Promise<boolean> {
  if (!envelope || typeof envelope.signature !== "string" || !HEX_KEY.test(envelope.signature)) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), fromHex(envelope.signature), encode(envelope.body));
}

export async function requestHash(body: unknown): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encode(body)));
}

export function generateLearningSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

// ── Admission: the gate every request passes before it reaches the ledger ──

export type RefusalReason = "invalid" | "not-paired" | "bad-signature" | "expired";
export type Admission =
  | { ok: true; request: LearningRequest; hash: string }
  | { ok: false; reason: RefusalReason };

const ID = /^[\w-]{1,100}$/;
const FIELDS = new Set(["version", "id", "kind", "createdAt", "cardId", "cardVersion", "source", "harness", "toolchain", "level", "exercise", "summary", "diagnostic"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const shortText = (v: unknown, max: number) => v === undefined || (typeof v === "string" && v.length <= max);

function wellFormed(r: Record<string, unknown>): boolean {
  if (r.version !== 1 || typeof r.id !== "string" || !ID.test(r.id)) return false;
  if (r.kind !== "check" && r.kind !== "help") return false;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return false;
  if (typeof r.cardId !== "string" || typeof r.cardVersion !== "string") return false;
  if (typeof r.source !== "string" || r.source.length > MAX_SOURCE) return false;
  if (Object.keys(r).some((k) => !FIELDS.has(k))) return false;
  if (!shortText(r.toolchain, 40) || !shortText(r.summary, MAX_CONTEXT) || !shortText(r.diagnostic, MAX_CONTEXT)) return false;
  if (r.kind === "check") return isObject(r.harness);
  return ["nudge", "hint", "solution"].includes(r.level as string) && (r.exercise === undefined || isObject(r.exercise));
}

/**
 * Whether Workstreams may queue this entry of `requests`. Shape is checked
 * before the signature, the signature before freshness. Running it twice is
 * safe: the ledger keys jobs by id and refuses a reused id with new content.
 */
export async function admitRequest(id: string, raw: string, secret: string, now: number): Promise<Admission> {
  const refuse = (reason: RefusalReason): Admission => ({ ok: false, reason });
  if (typeof raw !== "string" || raw.length > MAX_ENVELOPE) return refuse("invalid");
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { return refuse("invalid"); }
  if (!isObject(envelope) || !isObject(envelope.body) || !wellFormed(envelope.body) || envelope.body.id !== id) return refuse("invalid");
  if (!HEX_KEY.test(secret)) return refuse("not-paired");
  const signed = envelope as unknown as Envelope<LearningRequest>;
  if (!(await verify(signed, secret))) return refuse("bad-signature");
  const createdAt = signed.body.createdAt;
  if (now - createdAt > REQUEST_TTL_MS || createdAt - now > CLOCK_SKEW_MS) return refuse("expired");
  return { ok: true, request: signed.body, hash: await requestHash(signed.body) };
}

export function refusalMessage(reason: RefusalReason): string {
  switch (reason) {
    case "invalid": return "Workstreams could not read this request. Update Rust Pocket.";
    case "not-paired": return "Rust Pocket is not paired with this Mac. Pair it in Workstreams Settings.";
    case "bad-signature": return "This phone's learning key is not the paired one. Scan the code in Workstreams Settings again.";
    case "expired": return "The request arrived too late (more than 5 minutes) or the phone's clock is off. Check again.";
  }
}

/** The ledger's `JobRequest` (src-tauri/src/learning_jobs.rs). */
export function toJobRequest(r: LearningRequest): Record<string, unknown> {
  const card = { id: r.id, card_id: r.cardId, card_version: r.cardVersion };
  if (r.kind === "check") {
    return { kind: "check", ...card, harness: r.harness, source: r.source, ...(r.toolchain ? { toolchain: r.toolchain } : {}) };
  }
  return {
    kind: "help", ...card, level: r.level, exercise: r.exercise ?? {}, source: r.source,
    ...(r.summary !== undefined ? { summary: r.summary } : {}),
    ...(r.diagnostic !== undefined ? { diagnostic: r.diagnostic } : {}),
  };
}

// ── Pairing ──────────────────────────────────────────────────────────────

export interface LearningPairing { doc: string; secret: string; server: string }

/** The QR payload. `app` keeps it from being mistaken for a companion code. */
export function encodeLearningPairing(pairing: LearningPairing): string {
  return JSON.stringify({ v: 1, app: "rust-pocket", doc: pairing.doc, secret: pairing.secret, server: pairing.server });
}

export function decodeLearningPairing(text: string): LearningPairing | null {
  try {
    const p = JSON.parse(text) as Record<string, unknown>;
    if (p?.v !== 1 || p.app !== "rust-pocket") return null;
    if (typeof p.doc !== "string" || !/^automerge:[1-9A-HJ-NP-Za-km-z]+$/.test(p.doc)) return null;
    if (typeof p.secret !== "string" || !HEX_KEY.test(p.secret)) return null;
    if (typeof p.server !== "string") return null;
    return { doc: p.doc, secret: p.secret, server: p.server };
  } catch {
    return null;
  }
}
