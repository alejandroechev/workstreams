/**
 * Minimal back/forward navigation stack. Pure, host-agnostic.
 *
 * Usage:
 *   let nav = createNavigationStack("a.md");
 *   nav = pushPath(nav, "b.md");      // current = "b.md", canBack = true
 *   nav = pushPath(nav, "c.md");      // current = "c.md"
 *   nav = goBack(nav);                // current = "b.md"
 *   nav = goForward(nav);             // current = "c.md"
 *   nav = pushPath(nav, "d.md");      // forward stack is cleared
 */

export interface NavigationStack {
  readonly entries: ReadonlyArray<string>;
  /** Zero-based index into `entries` of the current entry. */
  readonly cursor: number;
}

export function createNavigationStack(initial: string): NavigationStack {
  return { entries: [initial], cursor: 0 };
}

export function currentPath(nav: NavigationStack): string {
  return nav.entries[nav.cursor];
}

export function canGoBack(nav: NavigationStack): boolean {
  return nav.cursor > 0;
}

export function canGoForward(nav: NavigationStack): boolean {
  return nav.cursor < nav.entries.length - 1;
}

/**
 * Push a new entry. Truncates any forward history (browser semantics).
 * No-op if `path` equals the current entry — prevents duplicates from
 * clicking the same link twice.
 */
export function pushPath(nav: NavigationStack, path: string): NavigationStack {
  if (currentPath(nav) === path) return nav;
  const truncated = nav.entries.slice(0, nav.cursor + 1);
  return { entries: [...truncated, path], cursor: truncated.length };
}

export function goBack(nav: NavigationStack): NavigationStack {
  if (!canGoBack(nav)) return nav;
  return { ...nav, cursor: nav.cursor - 1 };
}

export function goForward(nav: NavigationStack): NavigationStack {
  if (!canGoForward(nav)) return nav;
  return { ...nav, cursor: nav.cursor + 1 };
}

/** Replace the current entry without affecting history. */
export function replacePath(nav: NavigationStack, path: string): NavigationStack {
  const next = nav.entries.slice();
  next[nav.cursor] = path;
  return { ...nav, entries: next };
}
