/**
 * Narrowing a crate's test list down to something pickable.
 *
 * A flat dropdown does not scale: this repo alone has ~258 tests across a
 * dozen modules, which is unusable for finding one. Rust test names are
 * already hierarchical (`code_review::git::tests::resolve_base_ref`), so the
 * module path is a natural scope — no extra metadata needed from cargo.
 */

/** Placeholder group for a test with no module path. */
export const ROOT_MODULE = "(root)";

/** The module path of a test, i.e. everything before the final segment. */
export function moduleOf(testName: string): string {
  const idx = testName.lastIndexOf("::");
  return idx < 0 ? ROOT_MODULE : testName.slice(0, idx);
}

/** The final segment — what actually distinguishes tests within a module. */
export function shortTestName(testName: string): string {
  const idx = testName.lastIndexOf("::");
  return idx < 0 ? testName : testName.slice(idx + 2);
}

export interface TestGroup {
  readonly module: string;
  readonly tests: ReadonlyArray<string>;
}

/**
 * Group tests by module, sorting both groups and their contents.
 *
 * Sorted rather than input-ordered because cargo's listing order is an
 * implementation detail; a stable alphabetical list is what makes scanning for
 * a known name quick.
 */
export function groupTestsByModule(tests: ReadonlyArray<string>): TestGroup[] {
  const byModule = new Map<string, string[]>();
  for (const test of tests) {
    const module = moduleOf(test);
    const bucket = byModule.get(module);
    if (bucket) bucket.push(test);
    else byModule.set(module, [test]);
  }
  return Array.from(byModule.entries())
    .map(([module, groupTests]) => ({ module, tests: [...groupTests].sort() }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

/**
 * Filter tests by a free-text query.
 *
 * Every whitespace-separated term must appear somewhere in the full path, in
 * any order, so `pty shell` finds `pty::tests::resolves_shell` without the
 * user recalling the exact path. Input order is preserved so the caller can
 * group afterwards without surprises.
 */
export function filterTests(
  tests: ReadonlyArray<string>,
  query: string,
): string[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...tests];
  return tests.filter((test) => {
    const haystack = test.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
