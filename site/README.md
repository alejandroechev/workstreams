# Workstreams landing page

The public site at
[alejandroechev.github.io/workstreams](https://alejandroechev.github.io/workstreams/).

Plain HTML and CSS with no build step: GitHub Pages serves this folder as-is.
A bundler would add a toolchain without buying anything for a single static
page.

## Media

Screenshots and demo clips are **not** stored here. They live once in
`docs/assets/` — where the README and the feature deep-dive already reference
them — and `.github/workflows/pages.yml` copies that folder to `site/assets/`
when it publishes. Keeping a single copy avoids multi-megabyte binaries
drifting out of sync in two places.

To add a new clip:

1. Put the file in `docs/assets/`.
2. Reference it from `index.html` as `assets/<name>`.

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

Pages must be enabled once in **Settings → Pages → Source: GitHub Actions**.
