# ADR 005 — Repo Create vs. Import Flows

## Status
Accepted.

## Context

The Repo section of the sidebar offered a single "+" button that opened a
form titled "New Repo". The form was actually an **import** flow:
the user picked an existing directory, `detect_git_info` read its remote
and branch, and the project was saved. There was no path to create a brand
new git repository from inside the app — users had to drop to a terminal,
run `git init`, possibly `gh repo create`, and then come back to import.

We want to keep the import flow exactly as it is (it works) while adding a
**Create new repo** flow that scaffolds a folder, runs `git init`, makes
an initial commit, and can optionally create a GitHub remote.

## Decision

1. **Two distinct flows, surfaced via a dropdown menu** under the sidebar
   `+` button:
   - "Import existing repo" → existing `ProjectCreateForm` (retitled
     "Import Repo")
   - "Create new repo" → new `RepoCreateForm`
   We chose a popover menu over tabs-in-one-modal because the two flows
   share almost no fields (parent dir + name vs. existing dir + auto-detect)
   and a tab toggle would hide that asymmetry.

2. **`create_git_repo` Rust command** lives in `src-tauri/src/repo_create.rs`
   and performs, in order: validate name, create folder, write README +
   `.gitignore`, `git init -b <branch>` (fallback to `init` +
   `symbolic-ref` for old git), `git add -A && git commit -m "Initial commit"`,
   then optionally call a `RemoteRepoProvider` to create the GitHub remote.

3. **`RemoteRepoProvider` trait** is the external-integration boundary.
   `GhCliRemoteProvider` shells out to `gh` (the production impl).
   `InMemoryRemoteProvider` records calls and returns a deterministic URL
   (the test stub). This follows AGENTS.md's "in-memory stubs for external
   integrations" rule: the Rust unit tests cover the full create flow
   without needing `gh` authenticated, and offline dev is unaffected.

4. **After creation, reuse the import path**: `RepoCreateForm` invokes
   `create_git_repo`, receives the created directory + remote URL, and
   calls the same `handleCreateProject` callback that the import flow uses.
   The new repo lands in the project list with no special-casing.

5. **Defaults**:
   - Default branch: `master` (matches user's existing repos / global
     convention here).
   - Scaffold: `README.md` (title = repo name) + a multi-language
     `.gitignore` (Node + Rust + OS + editor).
   - Initial commit: always when scaffolding is enabled.
   - Remote: opt-in checkbox. Default owner: `alejandroechev`. Default
     visibility: private (radio toggle exposes Public).
   - Parent directory: always prompted via the OS folder picker.

## Consequences

- The sidebar `+` button now toggles a small popover instead of opening
  the import form directly. One extra click for import users; that is
  acceptable to keep the menu symmetric.
- The `WorkstreamSidebar` props gain `onImportProject` alongside the
  existing `onCreateProject` (now wired to the create-new flow). All
  callers were updated.
- `gh` is now an optional runtime dependency. If the user checks the
  "Create GitHub remote" box without `gh` installed or authenticated, the
  command surfaces the stderr from `gh auth status` verbatim in the
  modal. The local repo is still created — only the remote creation
  fails — so no rollback is needed.
- The `RemoteRepoProvider` boundary makes it trivial to add GitLab or
  bare-remote support later without touching the form or the
  scaffold/init logic.

## Out of scope (future work)

- Clone-from-URL flow (third menu entry).
- Non-GitHub remote providers.
- LICENSE / language-specific scaffold templates.
- Editing the seeded `.gitignore` from the form.
