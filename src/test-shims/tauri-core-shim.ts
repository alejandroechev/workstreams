// @test-skip: Browser shim for Tauri core; behaviour exercised by Playwright E2E.
/**
 * Browser-mode shim for `@tauri-apps/api/core`.
 * `invoke()` routes through window.__WS_INVOKE_HANDLERS__; default = null.
 */
declare global {
  interface Window {
    __WS_INVOKE_HANDLERS__?: Record<string, (args: Record<string, unknown>) => unknown>;
    __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }>;
  }
}
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const safeArgs = args ?? {};
  if (typeof window !== "undefined") {
    if (!window.__WS_INVOKE_LOG__) window.__WS_INVOKE_LOG__ = [];
    window.__WS_INVOKE_LOG__.push({ cmd, args: safeArgs });
    const handlers = window.__WS_INVOKE_HANDLERS__;
    if (handlers && typeof handlers[cmd] === "function") {
      return Promise.resolve(handlers[cmd](safeArgs) as T);
    }
  }
  return null as unknown as T;
}
export const transformCallback = () => 0;
