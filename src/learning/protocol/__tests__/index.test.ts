import { describe, expect, it } from "vitest";
import fixtures from "../fixtures.json";
import {
  admitRequest,
  decodeLearningPairing,
  encodeLearningPairing,
  generateLearningSecret,
  requestHash,
  sign,
  toJobRequest,
  verify,
  type LearningRequest,
} from "..";
import { checkRequest, generateSecret, signRequest, type UnsignedRequest } from "../../../companion/protocol";

const NOW = fixtures.request.body.createdAt + 1000;
const body = fixtures.request.body as LearningRequest;

describe("learning protocol", () => {
  it("signs and hashes exactly like the phone", async () => {
    expect((await sign(body, fixtures.secret)).signature).toBe(fixtures.request.signature);
    expect(await requestHash(body)).toBe(fixtures.requestHash);
    expect(await verify(fixtures.request, fixtures.secret)).toBe(true);
  });

  it("signs an undefined field as if it were absent, as JSON transmits it", async () => {
    const signed = await sign({ ...body, toolchain: undefined }, fixtures.secret);
    expect(await verify(JSON.parse(JSON.stringify(signed)), fixtures.secret)).toBe(true);
  });

  it("admits a fresh request signed with the learning key", async () => {
    const admitted = await admitRequest("attempt-1", JSON.stringify(fixtures.request), fixtures.secret, NOW);
    expect(admitted).toEqual({ ok: true, request: body, hash: fixtures.requestHash });
  });

  it("refuses a learning request signed with the companion key", async () => {
    const forged = await sign(body, generateLearningSecret());
    const companionKey = generateSecret();
    const asCompanion = await admitRequest("attempt-1", JSON.stringify(forged), companionKey, NOW);
    expect(asCompanion).toEqual({ ok: false, reason: "not-paired" });
    const wrongKey = await admitRequest("attempt-1", JSON.stringify(forged), fixtures.secret, NOW);
    expect(wrongKey).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("is refused by the companion when signed with the learning key", async () => {
    const request: UnsignedRequest = { id: "r1", kind: "load", args: { workstreamId: "w1" }, createdAt: NOW, schemaVersion: 1 } as UnsignedRequest;
    const signature = await signRequest(fixtures.secret, request);
    const companionKey = generateSecret();
    expect(await checkRequest({ ...request, signature }, { secret: companionKey, now: NOW })).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses stale, future, misfiled and malformed requests", async () => {
    const at = (createdAt: number) => sign({ ...body, createdAt }, fixtures.secret).then(JSON.stringify);
    expect(await admitRequest("attempt-1", await at(NOW - 6 * 60_000), fixtures.secret, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(await admitRequest("attempt-1", await at(NOW + 2 * 60_000), fixtures.secret, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(await admitRequest("other", JSON.stringify(fixtures.request), fixtures.secret, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await admitRequest("attempt-1", "{not json", fixtures.secret, NOW)).toEqual({ ok: false, reason: "invalid" });
    const odd = await sign({ ...body, kind: "status" }, fixtures.secret);
    expect(await admitRequest("attempt-1", JSON.stringify(odd), fixtures.secret, NOW)).toEqual({ ok: false, reason: "invalid" });
    const big = await sign({ ...body, source: "x".repeat(20_001) }, fixtures.secret);
    expect(await admitRequest("attempt-1", JSON.stringify(big), fixtures.secret, NOW)).toEqual({ ok: false, reason: "invalid" });
    const help = await sign({ ...body, kind: "help", level: "loud" }, fixtures.secret);
    expect(await admitRequest("attempt-1", JSON.stringify(help), fixtures.secret, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("turns admitted requests into ledger jobs", () => {
    expect(toJobRequest(body)).toEqual({
      kind: "check", id: "attempt-1", card_id: "even", card_version: "2",
      harness: body.harness, source: body.source, toolchain: "1.98.0",
    });
    expect(toJobRequest({ ...body, kind: "help", level: "hint", exercise: { prompt: "p" }, summary: "s", diagnostic: "d" })).toEqual({
      kind: "help", id: "attempt-1", card_id: "even", card_version: "2",
      level: "hint", exercise: { prompt: "p" }, source: body.source, summary: "s", diagnostic: "d",
    });
  });

  it("admits a pack request and turns it into a pack job", async () => {
    const pack = { ...body, kind: "pack" as const, cardId: "", cardVersion: "", source: "", harness: undefined, toolchain: undefined,
      topic: "Slices", packId: "pack-slices", previous: { id: "pack-slices", version: 1 }, notes: "fix" };
    const signed = await sign(pack, fixtures.secret);
    const admitted = await admitRequest("attempt-1", JSON.stringify(signed), fixtures.secret, NOW);
    expect(admitted.ok).toBe(true);
    expect(toJobRequest(pack)).toEqual({ kind: "pack", id: "attempt-1", topic: "Slices", pack_id: "pack-slices", previous: { id: "pack-slices", version: 1 }, notes: "fix" });
    const noTopic = await sign({ ...pack, topic: "" }, fixtures.secret);
    expect(await admitRequest("attempt-1", JSON.stringify(noTopic), fixtures.secret, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("has a pairing code of its own that the companion format does not accept", () => {
    const secret = generateLearningSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    const code = encodeLearningPairing({ doc: "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ", secret, server: "https://sync.example" });
    expect(decodeLearningPairing(code)).toEqual({ doc: "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ", secret, server: "https://sync.example" });
    expect(decodeLearningPairing(JSON.stringify({ v: 1, doc: "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ", secret: generateSecret() }))).toBeNull();
    expect(decodeLearningPairing("nope")).toBeNull();
  });
});
