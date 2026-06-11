# Contributing

## Commit message convention

This repo uses **[Conventional Commits](https://www.conventionalcommits.org/)**. Pushing to `master` runs the [CI workflow](.github/workflows/ci.yml) — tests, lint, coverage gate, doc gate, E2E. No tag, no release.

Releases are **manual**: GitHub → Actions → **Release** → *Run workflow*. The [release workflow](.github/workflows/release.yml) accepts an optional `version` input:

- **Leave blank** → the next semver tag is auto-computed from your commit messages since the previous tag (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major).
- **Enter `v0.3.0` (or similar)** → forces that exact tag.

The job stamps the version into `package.json` + `tauri.conf.json`, runs `tauri build` on `windows-latest`, creates the git tag, and publishes a GitHub Release with the NSIS installer, MSI installer, and raw `workstreams-vX.Y.Z.exe` attached.

### Bump rules (when auto-computing)

| Commit prefix | Bump kind | Example |
|---|---|---|
| `feat:` / `feat(scope):` | **minor** | `feat(repo): add Diff tab filter` |
| `fix:` / `perf:` / `refactor:` / `chore:` / `test:` / `style:` / `build:` / `ci:` / `revert:` | **patch** | `fix(window): grant allow-destroy permission` |
| `docs:` only | **none** — auto-compute will refuse to release (set `version` explicitly to override) | `docs: update tutorial` |
| `<any-type>!:` or body contains `BREAKING CHANGE:` | **major** | `feat!: rewrite tile persistence schema` |
| Anything else (no recognised prefix) | **patch** (safe default) | — |

The **strongest** bump across the range wins. If multiple commits are batched (`fix:` + `feat:` + `docs:`), the result is a **minor** bump.

### Examples

```
v0.1.0 → fix: …                      → v0.1.1
v0.1.1 → feat: …                     → v0.2.0
v0.2.0 → docs: …                     → auto-compute refuses (use explicit version)
v0.2.0 → docs: …    + fix: …         → v0.2.1
v0.2.0 → feat: …    + fix: …         → v0.3.0
v0.2.0 → feat!: …                    → v1.0.0
```

## Source-of-truth files

- `package.json` `"version"` and `src-tauri/tauri.conf.json` `"version"` are **decorative** — they're stamped at release time from the resolved tag. Their committed value is what the dev binary reports between releases.
- Git tags `v<major>.<minor>.<patch>` are the actual source of truth.

## Local testing

The pre-push hook is the canonical local gate and mirrors CI. See `docs/contributor-guide.md` for details on hooks, commands, and the test pyramid.
