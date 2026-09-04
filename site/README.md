# Workstreams landing page

The public site at
[alejandroechev.github.io/workstreams](https://alejandroechev.github.io/workstreams/).

Plain HTML and CSS with no build step: GitHub Pages serves this folder as-is.
A bundler would add a toolchain without buying anything for a single static
page.

## Downloads

`downloads.js` asks GitHub's public latest-release API for the current tag and
assets, then changes all three primary calls to action to the best installer
for the visitor:

- Windows → the x64 setup `.exe`;
- macOS → the Apple Silicon `.dmg`;
- anything else → the complete release page.

The release eyebrow uses the same response for its tag and publication date.
Every link starts as `releases/latest`, so the page remains usable when
JavaScript is disabled, GitHub is unavailable, or the API rate limit is
exhausted. **All downloads** is always visible as the platform escape hatch.

Pure platform, asset-selection and release-formatting logic is covered by
`scripts/__tests__/site-downloads.test.mjs`; that test also pins the required
landing-page data attributes.

## Media

Screenshots and demo clips are **not** stored here. They live once in
`docs/assets/` — where the README and the feature deep-dive already reference
them — and `.github/workflows/pages.yml` copies that folder to `site/assets/`
when it publishes. Keeping a single copy avoids multi-megabyte binaries
drifting out of sync in two places.

Demo media is declared in `demos/manifest.json`. The manifest records every
scenario and shared source that affects the pixels or encoding, the expected
codec and dimensions, size and duration budgets, and every publication
reference.

1. Add the Playwright scenario and manifest entry.
2. Run `npm run demos:record` to generate the declared artifacts and source hash.
3. Reference each artifact from the files declared in its `references` list.
4. Run `npm run demos:check` to reject stale, malformed, missing, oversized, or
   incorrectly encoded media.

Recording scenarios use Playwright 1.60's `page.screencast` API against the
Vite E2E host and synthetic `MemoryBackend` data. The checker never launches
the app or rewrites media, and `--check` is safe for CI.

The dedicated `playwright.demo.config.ts` keeps recording scenarios out of the
normal E2E suite. Scenarios import `e2e/demos/fixtures.ts`, declare synthetic
projects, workstreams, tiles, and files through `demoSeed`, then drive visible
controls through the fixture's fixed 1280×800 dark-theme page.

## Local preview

Because the assets are copied at publish time, mirror that locally before
serving:

```sh
cp -R docs/assets site/assets   # gitignored; do not commit
python3 -m http.server -d site 8000
```

Then open <http://localhost:8000>.

## Publishing

Pushing to `master` triggers `.github/workflows/pages.yml`, which uploads this
folder plus the copied assets to GitHub Pages. The workflow can also be run
manually from the Actions tab.

The workflow enables Pages itself on first run (`configure-pages` with
`enablement: true`), so no manual setup is needed.
