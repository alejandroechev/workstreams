---
name: ws-artifact
description: 'Create and publish a public HTML artifact in alejandroechev/workstreams-artifacts on GitHub Pages, verify the live page, and include its URL in the reply. Use for "/ws-artifact", "publish an HTML artifact", or when a companion prompt asks to use ws-artifact if HTML is requested.'
---

# Publish a Workstreams HTML artifact

Use this skill only if the user actually requested an HTML artifact. A companion
toggle alone is not a request to create one.

## Destination and public-content boundary

- Repository: `alejandroechev/workstreams-artifacts`
- Site: `https://alejandroechev.github.io/workstreams-artifacts/`
- Each artifact: `artifacts/<YYYY-MM-DD>-<short-kebab-title>-<unique-id>/index.html`
- Published URL: the site URL plus that artifact directory and a trailing `/`.

**Everything committed is public**, including git history. Never publish secrets,
credentials, personal data, private source material, internal URLs, or confidential
documents. Do not copy a working directory or session transcript into the repo.
If the requested artifact requires restricted material, stop and ask for a
public-safe version; never sanitize by guessing. Do not add analytics, trackers,
external scripts, credentials, or authenticated backend dependencies.

## Create

1. Check `gh auth status` and `gh repo view alejandroechev/workstreams-artifacts`.
   If authentication is missing, report the blocker; do not switch accounts.
2. Use a dedicated clone under your session's `files/`, not the task's working
   repository. Discover existing paths first. Clone if absent:

   ```sh
   gh repo clone alejandroechev/workstreams-artifacts <dedicated-clone-path>
   ```

   Read its `AGENTS.md` and `README.md`. If reusing a clean clone, fetch and
   fast-forward its `main` branch. Never discard unrelated changes.
3. Create a unique directory as above (use a UUID suffix to avoid collisions).
   Keep the artifact self-contained: HTML with inline CSS/JS, a UTF-8 charset,
   a viewport meta tag, an English title, accessible controls, and no build step.
   Relative assets, if truly necessary, belong inside the same directory.
4. Add a descriptive relative link to the gallery in the repository's root
   `index.html`. Preserve every existing artifact and gallery link.

## Verify and publish

1. Open the HTML with Playwright and exercise its actual interactions at desktop
   and phone widths. Capture a screenshot in your session files and check the
   browser console for errors. Review the exact diff for public-safe content.
2. Stage only your artifact directory and the root gallery. Commit, then
   `git push origin main`. A request to publish an artifact authorizes those
   operations in this artifact repo, not pushes to any other repository.
   Never force-push. If another agent pushed first, fetch and rebase your
   commit; resolve gallery edits without dropping either artifact, then retry.
3. Find the **Deploy GitHub Pages** workflow run whose `headSha` matches the
   pushed commit, using `gh run list --repo alejandroechev/workstreams-artifacts
   --workflow pages.yml --json databaseId,headSha,status,conclusion`.
   Wait with `gh run watch <run-id> --repo alejandroechev/workstreams-artifacts
   --exit-status`. Do not mistake an older green run for your deployment.
4. Verify the exact published URL with `curl --fail --location <url>` and check
   its title/content matches your artifact. Retry briefly for Pages propagation.
   A successful push is not a successful deployment.
5. Include a clickable Markdown link in the final reply:
   `[View <artifact title>](https://alejandroechev.github.io/workstreams-artifacts/artifacts/<directory>/)`.
   In a phone-started session, use `companion-reply` to send that same link.
   If deployment or verification fails, state that explicitly and include the
   repository path for recovery; never claim a URL is live before verifying it.
