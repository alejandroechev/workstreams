import { isFresh, RETIRED_GRACE_MS, type CompanionDocument } from "./protocol";

/** Rotate once the saved document (its whole history) is bigger than this. */
export const ROTATE_ABOVE_BYTES = 2 * 1024 * 1024;
/** How often the size is checked after the check at connection. */
export const ROTATION_CHECK_MS = 24 * 60 * 60_000;
export { RETIRED_GRACE_MS };

export interface RotationOptions {
  aboveBytes: number;
  everyMs: number;
  graceMs: number;
}

export const DEFAULT_ROTATION: RotationOptions = {
  aboveBytes: ROTATE_ABOVE_BYTES,
  everyMs: ROTATION_CHECK_MS,
  graceMs: RETIRED_GRACE_MS,
};

export type RotationResult =
  | { ok: true; url: string }
  /** `queued`: a request is running; Rotate now goes ahead once it finishes. */
  | { ok: false; reason: "busy" | "queued" | "not-connected" | "error"; message?: string };

/**
 * Whether a request is waiting to run or running. A rotation waits for it,
 * so no in-flight state crosses documents. Stale unanswered entries (older
 * than the request lifetime) never run, so they do not block.
 */
export function hasOpenRequest(doc: CompanionDocument, now: number): boolean {
  return Object.values(doc.requests ?? {}).some((request) => {
    if (!request || typeof request !== "object") return false;
    if (request.outcome) return request.outcome.status === "running";
    return typeof request.createdAt === "number" && isFresh(request.createdAt, now);
  });
}
