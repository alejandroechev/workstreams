import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION,
  canonicalRequest,
  signRequest,
  checkRequest,
  parseRequest,
  isKnownSchema,
  isFresh,
  isLaptopOnline,
  laneColor,
  LANE_COLORS,
  generateSecret,
  encodePairing,
  decodePairing,
  REQUEST_TTL_MS,
  CLOCK_SKEW_MS,
  PRESENCE_TIMEOUT_MS,
  type CompanionRequest,
} from "../index";
import {
  RESULT_SUFFIX,
  emptyDocument,
  withResultRequest,
  sessionTitle,
  readSessions,
  sessionIsDone,
  checkMessage,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES_PER_SESSION,
  SESSION_RETENTION_MS,
  type CompanionDocument,
  type PhoneSession,
} from "..";
import fixtures from "../fixtures.json";

const SECRET = fixtures.secret;
const NOW = 1_790_000_000_000;

function base64urlToBytes(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function signed(request: Omit<CompanionRequest, "signature" | "outcome">, secret = SECRET): Promise<CompanionRequest> {
  return { ...request, signature: await signRequest(secret, request) };
}

const load = (over: Partial<CompanionRequest> = {}) =>
  ({ id: "r1", kind: "load", args: { workstreamId: "ws-1" }, createdAt: NOW, ...over }) as Omit<CompanionRequest, "signature" | "outcome">;

describe("canonical request form", () => {
  it("is independent of argument key order and drops absent optional args", () => {
    const a = canonicalRequest({ id: "r", kind: "create", args: { name: "N", prompt: "P" }, createdAt: 1 });
    const b = canonicalRequest({ id: "r", kind: "create", args: { prompt: "P", name: "N" }, createdAt: 1 });
    expect(a).toBe(b);
    const withoutPrompt = canonicalRequest({ id: "r", kind: "create", args: { name: "N", prompt: undefined }, createdAt: 1 });
    expect(withoutPrompt).toBe(canonicalRequest({ id: "r", kind: "create", args: { name: "N" }, createdAt: 1 }));
  });

  it("binds the schema version, id, kind, args and time", () => {
    const base = canonicalRequest(load());
    expect(canonicalRequest(load({ id: "r2" }))).not.toBe(base);
    expect(canonicalRequest(load({ createdAt: NOW + 1 }))).not.toBe(base);
    expect(canonicalRequest(load({ args: { workstreamId: "ws-2" } }))).not.toBe(base);
    expect(base).toContain(String(SCHEMA_VERSION));
  });
});

describe("signing", () => {
  // The vectors were produced with Node's crypto and the canonical form as
  // written in ADR 033, independently of this module, so agreeing with them is
  // agreement with a second implementation, not with ourselves.
  it("matches the independently generated vectors both repositories test against", async () => {
    expect(fixtures.vectors.length).toBeGreaterThanOrEqual(4);
    for (const vector of fixtures.vectors) {
      const { signature, ...unsigned } = vector.request as CompanionRequest;
      expect(await signRequest(SECRET, unsigned)).toBe(signature);
    }
  });

  it("produces a 64-character hex HMAC-SHA256", async () => {
    expect(await signRequest(SECRET, load())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("checking a request before executing it", () => {
  it("accepts a fresh, well-formed request signed with the pairing secret", async () => {
    expect(await checkRequest(await signed(load()), { secret: SECRET, now: NOW })).toEqual({ ok: true });
  });

  it.each([
    ["unsigned", async () => ({ ...load(), signature: "" }) as CompanionRequest],
    ["bad-signature", async () => signed(load(), generateSecret())],
    ["bad-signature", async () => ({ ...(await signed(load())), args: { workstreamId: "ws-other" } })],
    ["expired", async () => signed(load({ createdAt: NOW - REQUEST_TTL_MS - 1 }))],
    ["from-the-future", async () => signed(load({ createdAt: NOW + CLOCK_SKEW_MS + 1 }))],
    ["already-handled", async () => ({ ...(await signed(load())), outcome: { status: "done" as const, at: NOW } })],
    ["already-handled", async () => ({ ...(await signed(load())), outcome: { status: "running" as const, at: NOW } })],
  ] as const)("refuses %s", async (reason, make) => {
    const result = await checkRequest(await make(), { secret: SECRET, now: NOW });
    expect(result).toEqual({ ok: false, reason });
  });

  it("refuses a malformed request before looking at its signature", async () => {
    const malformed = { ...(await signed(load())), kind: "rm -rf" } as unknown as CompanionRequest;
    expect(await checkRequest(malformed, { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses everything when no pairing secret is configured", async () => {
    expect(await checkRequest(await signed(load()), { secret: "", now: NOW })).toEqual({ ok: false, reason: "not-paired" });
  });
});

describe("request shapes", () => {
  it("accepts the three kinds with their arguments", () => {
    expect(parseRequest(load()).ok).toBe(true);
    expect(parseRequest({ ...load(), kind: "create", args: { name: "Idea" } }).ok).toBe(true);
    expect(parseRequest({ ...load(), kind: "create", args: { name: "Idea", prompt: "Do it" } }).ok).toBe(true);
    expect(parseRequest({ ...load(), kind: "session", args: { workstreamId: "w", prompt: "Line 1\nLine 2" } }).ok).toBe(true);
  });

  it.each([
    ["unknown kind", { ...load(), kind: "delete" }],
    ["missing workstream", { ...load(), args: {} }],
    ["blank create name", { ...load(), kind: "create", args: { name: "   " } }],
    ["session without prompt", { ...load(), kind: "session", args: { workstreamId: "w", prompt: "" } }],
    ["non-string prompt", { ...load(), kind: "session", args: { workstreamId: "w", prompt: 5 } }],
    ["unexpected argument", { ...load(), args: { workstreamId: "w", command: "rm -rf /" } }],
    ["oversized prompt", { ...load(), kind: "session", args: { workstreamId: "w", prompt: "x".repeat(20_001) } }],
    ["non-numeric time", { ...load(), createdAt: "now" }],
    ["missing id", { ...load(), id: "" }],
  ])("rejects %s", (_label, raw) => {
    expect(parseRequest(raw).ok).toBe(false);
  });
});

describe("versioning, freshness and presence", () => {
  it("knows only its own major schema version", () => {
    expect(isKnownSchema({ schemaVersion: SCHEMA_VERSION })).toBe(true);
    expect(isKnownSchema({ schemaVersion: SCHEMA_VERSION + 1 })).toBe(false);
    expect(isKnownSchema({})).toBe(false);
  });

  it("treats the 5-minute window and 1-minute skew as inclusive bounds", () => {
    expect(isFresh(NOW - REQUEST_TTL_MS, NOW)).toBe(true);
    expect(isFresh(NOW + CLOCK_SKEW_MS, NOW)).toBe(true);
    expect(isFresh(NOW - REQUEST_TTL_MS - 1, NOW)).toBe(false);
  });

  it("calls the laptop online only while presence is recent", () => {
    expect(isLaptopOnline(NOW - PRESENCE_TIMEOUT_MS, NOW)).toBe(true);
    expect(isLaptopOnline(NOW - PRESENCE_TIMEOUT_MS - 1, NOW)).toBe(false);
    expect(isLaptopOnline(null, NOW)).toBe(false);
  });
});

describe("lane colours", () => {
  it("are stable per lane and drawn from the shared palette", () => {
    expect(laneColor("lane-a")).toBe(laneColor("lane-a"));
    expect(LANE_COLORS).toContain(laneColor("lane-a"));
    const colors = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => laneColor(`lane-${id}`)));
    expect(colors.size).toBeGreaterThan(3);
  });

  it("are grey for a workstream with no lane", () => {
    expect(laneColor(null)).toBe("#45475a");
  });

  it("match the shared fixture, so both apps colour a lane the same", () => {
    for (const [id, color] of Object.entries(fixtures.laneColors)) expect(laneColor(id)).toBe(color);
  });
});

describe("pairing", () => {
  it("generates 32-byte url-safe secrets", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64urlToBytes(secret)).toHaveLength(32);
    expect(generateSecret()).not.toBe(secret);
  });

  it("round-trips the QR payload and rejects anything else", () => {
    const pairing = { doc: "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh", secret: SECRET };
    expect(decodePairing(encodePairing(pairing))).toEqual(pairing);
    for (const bad of [
      "",
      "not json",
      JSON.stringify({ v: 2, ...pairing }),
      JSON.stringify({ v: 1, doc: "https://evil", secret: SECRET }),
      JSON.stringify({ v: 1, doc: pairing.doc, secret: "short" }),
    ]) {
      expect(decodePairing(bad)).toBeNull();
    }
  });
});

describe("phone sessions and messages", () => {
  it("appends the fixed result request only when asked", () => {
    expect(RESULT_SUFFIX).toBe(fixtures.resultSuffix);
    expect(withResultRequest("Do x", true)).toBe("Do x" + fixtures.resultSuffix);
    expect(withResultRequest("Do x", false)).toBe("Do x");
    expect(withResultRequest("Do x  \n\n", true)).toBe("Do x" + fixtures.resultSuffix);
  });

  it("titles a session with the first non-empty line of its prompt", () => {
    for (const [prompt, title] of fixtures.titles) expect(sessionTitle(prompt)).toBe(title);
  });

  it("reads published sessions defensively, newest first", () => {
    const doc = { ...emptyDocument(), sessions: fixtures.sessions.document } as unknown as CompanionDocument;
    expect(readSessions(doc)).toEqual(fixtures.sessions.expected);
  });

  it("reads nothing from a document without sessions, or from another version", () => {
    expect(readSessions(emptyDocument())).toEqual([]);
    const doc = { ...emptyDocument(), schemaVersion: 2, sessions: fixtures.sessions.document } as unknown as CompanionDocument;
    expect(readSessions(doc)).toEqual([]);
    expect(readSessions({ ...emptyDocument(), sessions: "nope" } as unknown as CompanionDocument)).toEqual([]);
  });

  it("a session is done once it has a result", () => {
    const [newer, older] = fixtures.sessions.expected as PhoneSession[];
    expect(sessionIsDone(older)).toBe(true);
    expect(sessionIsDone(newer)).toBe(false);
  });

  it("validates a message an agent wants to send", () => {
    expect(checkMessage("result", "fine")).toEqual({ ok: true });
    expect(checkMessage("progress", "x".repeat(MAX_MESSAGE_LENGTH))).toEqual({ ok: true });
    expect(checkMessage("progress", "x".repeat(MAX_MESSAGE_LENGTH + 1))).toEqual({ ok: false, error: `The message is longer than ${MAX_MESSAGE_LENGTH} characters.` });
    expect(checkMessage("question", "x")).toEqual({ ok: false, error: 'The kind must be "progress" or "result".' });
    expect(checkMessage("result", "   ")).toEqual({ ok: false, error: "The message is empty." });
  });

  it("states the retention rules", () => {
    expect(SESSION_RETENTION_MS).toBe(3 * 24 * 60 * 60_000);
    expect(MAX_MESSAGES_PER_SESSION).toBe(50);
  });
});
