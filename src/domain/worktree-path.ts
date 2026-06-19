/**
 * Pure worktree path derivation — mirrors the Rust folder-naming rule in
 * `create_worktree` so the workstream record can be created with its final
 * directory BEFORE any git runs (the up-front path the create flow needs).
 *
 * Rule (matches src-tauri/src/lib.rs::create_worktree):
 *  - branch suffix = the last `/`-separated segment of the branch name
 *  - folder name   = `<repo>-<suffix>` unless the suffix already starts with
 *                    `<repo>-`, else just `<suffix>` (or the bare suffix when
 *                    no repo name is known)
 *  - worktree path = sibling of the project directory (its parent + folder)
 *
 * Separator style of the project directory is preserved.
 */

/** Last path segment, ignoring a trailing separator. Works for `\` and `/`. */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Parent directory, with the trailing separator stripped. Preserves style. */
export function parentDirOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? "" : trimmed.slice(0, idx);
}

/** Derive just the worktree folder name from the repo + branch names. */
export function deriveWorktreeFolderName(repoName: string | null | undefined, branchName: string): string {
  const branchSuffix = branchName.split("/").filter(Boolean).pop() ?? branchName;
  if (repoName && !branchSuffix.startsWith(`${repoName}-`)) {
    return `${repoName}-${branchSuffix}`;
  }
  return branchSuffix;
}

/**
 * Full worktree path: a sibling of `projectDirectory` named via
 * {@link deriveWorktreeFolderName}. `repoName` defaults to the project
 * directory's own folder name (the common case: creating a worktree from a
 * main repo clone). Pass an explicit `repoName` to mirror Rust's canonical
 * repo-name resolution for the rarer worktree-of-worktree case.
 */
export function deriveWorktreePath(
  projectDirectory: string,
  branchName: string,
  repoName?: string | null,
): string {
  const sep = projectDirectory.includes("\\") && !projectDirectory.includes("/") ? "\\" : "/";
  const repo = repoName ?? basenameOf(projectDirectory);
  const folder = deriveWorktreeFolderName(repo, branchName);
  const parent = parentDirOf(projectDirectory);
  return parent ? `${parent}${sep}${folder}` : folder;
}
