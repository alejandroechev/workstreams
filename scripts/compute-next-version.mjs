/**
 * Pure SemVer next-version computer driven by Conventional Commits.
 *
 * Rules:
 *   - `<type>!:` or "BREAKING CHANGE" in body  → major bump
 *   - `feat[(scope)]:`                          → minor bump
 *   - `fix:`, `perf:`, `refactor:`, `chore:`,  → patch bump
 *     `test:`, `style:`, `build:`, `ci:`,
 *     `revert:`
 *   - `docs:` (and only that)                   → no bump signal
 *   - anything else (no recognised prefix)      → patch bump (safe default)
 *
 * The chosen bump is the strongest one across the commit range. A range
 * consisting solely of `docs:` commits returns null → CI skips the release.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export const BUMP_NONE = "none";
export const BUMP_PATCH = "patch";
export const BUMP_MINOR = "minor";
export const BUMP_MAJOR = "major";

const RANK = { [BUMP_NONE]: 0, [BUMP_PATCH]: 1, [BUMP_MINOR]: 2, [BUMP_MAJOR]: 3 };

/** Classify a single commit message (subject + optional body, lines separated by \n). */
export function classifyCommit(message) {
  const trimmed = (message || "").trim();
  if (!trimmed) return BUMP_PATCH;

  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const body = trimmed.slice(firstLine.length).trim();

  // Breaking change marker — either `!` before the colon or `BREAKING CHANGE:` in body.
  if (/^(\w+)(\([^)]*\))?!:/.test(firstLine)) return BUMP_MAJOR;
  if (/(^|\n)BREAKING CHANGE:/i.test(body)) return BUMP_MAJOR;

  const typeMatch = firstLine.match(/^(\w+)(\([^)]*\))?:/);
  if (!typeMatch) return BUMP_PATCH;
  const type = typeMatch[1].toLowerCase();

  if (type === "feat") return BUMP_MINOR;
  if (type === "docs") return BUMP_NONE;
  if (["fix", "perf", "refactor", "chore", "test", "style", "build", "ci", "revert"].includes(type)) return BUMP_PATCH;
  return BUMP_PATCH;
}

/** Pick the strongest bump from a list of commit messages. */
export function selectBump(messages) {
  let strongest = BUMP_NONE;
  for (const m of messages) {
    const b = classifyCommit(m);
    if (RANK[b] > RANK[strongest]) strongest = b;
  }
  return strongest;
}

/** Parse a tag like "v1.2.3" → [1,2,3]. Returns null for non-SemVer. */
export function parseTag(tag) {
  if (!tag) return null;
  const stripped = tag.startsWith("v") ? tag.slice(1) : tag;
  const m = stripped.match(SEMVER_RE);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function formatTag(major, minor, patch) {
  return `v${major}.${minor}.${patch}`;
}

/**
 * Compute the next version.
 *
 * @param {string|null} lastTag   most recent SemVer tag, or null/undefined if none
 * @param {string[]} messages     commit messages from (lastTag, HEAD]
 * @param {object}  opts
 * @param {string}  opts.fallback baseline used when lastTag is missing (e.g. "v0.1.0")
 * @returns {{ tag: string, bump: string } | null}
 *   - null when there's nothing to release (no commits or only docs).
 *   - { tag, bump } otherwise.
 */
export function computeNextVersion(lastTag, messages, opts = {}) {
  const fallback = opts.fallback || "v0.1.0";

  if (!messages || messages.length === 0) return null;

  const bump = selectBump(messages);
  if (bump === BUMP_NONE) return null;

  const parsed = parseTag(lastTag) || parseTag(fallback);
  if (!parsed) throw new Error(`Cannot parse tag: ${lastTag ?? fallback}`);
  let [major, minor, patch] = parsed;

  // First-ever release uses the fallback as-is if there's no previous tag.
  if (!parseTag(lastTag)) {
    return { tag: formatTag(major, minor, patch), bump };
  }

  if (bump === BUMP_MAJOR) {
    major += 1; minor = 0; patch = 0;
  } else if (bump === BUMP_MINOR) {
    minor += 1; patch = 0;
  } else {
    patch += 1;
  }

  return { tag: formatTag(major, minor, patch), bump };
}
