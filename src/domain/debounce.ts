/**
 * Returns a debounced version of `fn`. Calls are coalesced — only the LAST
 * call within a `waitMs` quiet window actually fires.
 *
 * Used to coalesce bursts of fs-change events into a single refresh: a
 * `git checkout`, `npm install`, or build can fire hundreds of fs-changes
 * in a few milliseconds, and without debouncing every Repo Explorer
 * subscriber runs a full `listDirectory()` round-trip per event.
 *
 * Returns a function with a `.cancel()` method so React effect cleanups
 * can drop the pending invocation on unmount.
 */
export interface DebouncedFn<TArgs extends unknown[]> {
  (...args: TArgs): void;
  cancel: () => void;
}

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  waitMs: number,
): DebouncedFn<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: TArgs | null = null;
  const wrapped = ((...args: TArgs) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn(...a);
    }, waitMs);
  }) as DebouncedFn<TArgs>;
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };
  return wrapped;
}
