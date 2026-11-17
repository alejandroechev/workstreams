// @test-skip: Browser shim; no-ops only.
declare global {
  interface Window {
    /** E2E seam: answers the Save dialog (default: cancelled). */
    __WS_DIALOG_SAVE__?: (opts: unknown) => string | null;
  }
}
export async function open(_opts?: unknown): Promise<string | null> { return null; }
export async function save(opts?: unknown): Promise<string | null> {
  if (typeof window === "undefined") return null;
  (window.__WS_INVOKE_LOG__ ??= []).push({ cmd: "dialog_save", args: (opts ?? {}) as Record<string, unknown> });
  return window.__WS_DIALOG_SAVE__?.(opts) ?? null;
}
