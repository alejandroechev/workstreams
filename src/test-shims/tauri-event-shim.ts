// @test-skip: Browser shim; in-memory event bus for E2E.
/**
 * Browser-mode shim for `@tauri-apps/api/event`. Provides a tiny in-memory
 * event bus so E2E code (and the invoke shim's handlers) can drive Tauri
 * events like `worktree-progress`. Exposes `window.__WS_EMIT__` so Playwright
 * init scripts can emit events from invoke handlers.
 */
export type UnlistenFn = () => void;

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();

export async function listen<T = unknown>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (!listeners.has(event)) listeners.set(event, new Set());
  const set = listeners.get(event)!;
  set.add(handler as Handler);
  return () => { set.delete(handler as Handler); };
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  listeners.get(event)?.forEach((h) => h({ payload }));
}

declare global {
  interface Window {
    __WS_EMIT__?: (event: string, payload?: unknown) => void;
  }
}

if (typeof window !== "undefined") {
  window.__WS_EMIT__ = (event: string, payload?: unknown) => { void emit(event, payload); };
}
